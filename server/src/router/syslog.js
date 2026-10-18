/**
 * Syslog over UDP: a lenient parser (RFC 5424, RFC 3164 and the bare "<PRI>message" some routers send)
 * and a receiver that only accepts datagrams from an allowed source address.
 */
import dgram from 'node:dgram';

export const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const MAX_MESSAGE = 2048;

const RFC5424 = /^1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|(?:\[.*?\])+) ?(.*)$/s;
const RFC3164_TS = /^([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (.*)$/s;
const ISO_TS = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?) (.*)$/s;
const TAG = /^([A-Za-z0-9_.\-/]{1,48})(?:\[(\d+)\])?: ?(.*)$/s;

const nil = (v) => (v === '-' ? null : v);
const clean = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+$/, '').slice(0, MAX_MESSAGE);

/**
 * Parse one syslog datagram.
 * @param {Buffer|string} raw
 * @param {number} [now] ms epoch, used for the year of RFC 3164 timestamps
 * @returns {{ facility: number|null, severity: number, severityName: string, sentAt: string|null,
 *             host: string|null, app: string|null, message: string }}
 */
export function parseSyslog(raw, now = Date.now()) {
  let s = clean(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '')).replace(/^﻿/, '').trimStart();
  let facility = null;
  let severity = 6; // no PRI: treat as info
  const pri = /^<(\d{1,3})>/.exec(s);
  if (pri && Number(pri[1]) <= 191) {
    facility = Math.floor(Number(pri[1]) / 8);
    severity = Number(pri[1]) % 8;
    s = s.slice(pri[0].length);
  }
  const out = { facility, severity, severityName: SEVERITIES[severity], sentAt: null, host: null, app: null, message: s };

  const m5424 = RFC5424.exec(s);
  if (m5424) {
    const ts = Date.parse(m5424[1]);
    out.sentAt = Number.isFinite(ts) ? new Date(ts).toISOString() : null;
    out.host = nil(m5424[2]);
    out.app = nil(m5424[3]);
    out.message = m5424[7].replace(/^﻿/, '');
    return out;
  }

  let rest = s;
  const m3164 = RFC3164_TS.exec(rest);
  const mIso = m3164 ? null : ISO_TS.exec(rest);
  if (m3164) {
    const d = new Date(now);
    let year = d.getFullYear();
    // "Dec 31" received on Jan 1 belongs to last year.
    if (MONTHS[m3164[1]] > d.getMonth() + 1) year -= 1;
    const ts = new Date(year, MONTHS[m3164[1]] ?? 0, Number(m3164[2]), Number(m3164[3]), Number(m3164[4]), Number(m3164[5]));
    out.sentAt = Number.isFinite(ts.getTime()) ? ts.toISOString() : null;
    rest = m3164[6];
  } else if (mIso) {
    const ts = Date.parse(mIso[1].replace(' ', 'T'));
    out.sentAt = Number.isFinite(ts) ? new Date(ts).toISOString() : null;
    rest = mIso[2];
  }

  if (m3164 || mIso) {
    // HOSTNAME is next unless the remainder already starts with "TAG:".
    const tagFirst = TAG.exec(rest);
    if (!tagFirst || / /.test(rest.split(':')[0])) {
      const sp = rest.indexOf(' ');
      if (sp > 0) { out.host = rest.slice(0, sp); rest = rest.slice(sp + 1); }
    }
  }
  const tag = TAG.exec(rest);
  if (tag) { out.app = tag[1]; rest = tag[3]; }
  out.message = rest.trim();
  return out;
}

/**
 * Internet-link state change in a router log line, or null. Vendor-neutral wording only: lines that name
 * the WAN / PPP / uplink / internet side and say it went up or down, e.g. "WAN1 is down",
 * "Interface 'wan' is now up", "pppoe-wan: link down", "ppp0: connection lost", "Internet connection restored".
 * @returns {{ wan: string, state: 'up'|'down' } | null}
 */
export function detectWanChange(message) {
  if (typeof message !== 'string') return null;
  // A WAN name ("WAN2") is the most specific; otherwise the PPP session, uplink or plain "internet".
  const wan = /\b(WAN(?:\/LAN)?\s?\d*)\b/i.exec(message) || /\b(PPPoE[\w-]*|ppp\d+|uplink\d*|internet)\b/i.exec(message);
  if (!wan) return null;
  const raw = wan[1].replace(/\s+/g, '');
  const name = /^wan/i.test(raw) ? raw.toUpperCase() : raw.toLowerCase();
  if (/\b(link\s+(?:is\s+)?down|down|disconnected|offline|unplugged|failed|lost|terminated)\b/i.test(message)) return { wan: name, state: 'down' };
  if (/\b(link\s+(?:is\s+)?up|up|connected|online|plugged|restored|recovered)\b/i.test(message)) return { wan: name, state: 'up' };
  return null;
}

/**
 * UDP syslog listener on 0.0.0.0:<port>.
 * @param {object} opts
 * @param {number} opts.port
 * @param {(address: string) => boolean} opts.accept   source filter (e.g. only the router)
 * @param {(parsed: object, rinfo: object) => void} opts.onMessage
 * @param {(address: string) => void} [opts.onDropped]
 * @returns {{ start(): Promise<void>, stop(): void, port: number }}
 */
export function createSyslogReceiver({ port, accept, onMessage, onDropped, host = '0.0.0.0' }) {
  let socket = null;

  function start() {
    return new Promise((resolve, reject) => {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      const onStartError = (err) => {
        socket?.close?.();
        socket = null;
        reject(friendlyBindError(err, port));
      };
      socket.once('error', onStartError);
      socket.on('message', (buf, rinfo) => {
        if (!accept(rinfo.address)) { onDropped?.(rinfo.address); return; }
        try {
          onMessage(parseSyslog(buf), rinfo);
        } catch (err) {
          console.warn(`[syslog] handler failed: ${err?.message || err}`);
        }
      });
      socket.bind(port, host, () => {
        socket.off('error', onStartError);
        socket.on('error', (err) => console.warn(`[syslog] socket error: ${err?.message || err}`));
        resolve();
      });
    });
  }

  function stop() {
    if (!socket) return;
    try { socket.close(); } catch { /* ignore */ }
    socket = null;
  }

  return { start, stop, port };
}

function friendlyBindError(err, port) {
  const e = new Error(err?.message || String(err));
  e.code = err?.code;
  if (err?.code === 'EACCES') {
    e.message = `Not allowed to listen on UDP ${port}. Ports below 1024 need administrator rights on Linux`
      + ' (or setcap cap_net_bind_service on node); macOS and Windows allow it.';
  } else if (err?.code === 'EADDRINUSE') {
    e.message = `UDP ${port} is already in use by another program (another syslog server?).`;
  }
  return e;
}
