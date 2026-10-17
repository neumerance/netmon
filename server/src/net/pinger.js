// ICMP ping via the system `ping` binary (no root, no native modules) and the per-device latency sampler.
// PLAN.md §2.3. execFile only, IPs are validated before they reach argv.
//
// Flag notes (validated on macOS 26 / Darwin 25, see docs/NETWORK_NOTES.md §2):
//   macOS:  -t <s> is the overall deadline (NOT TTL), -W <ms> the reply wait, -i 0.1 shortens the send
//           interval so a dead host costs ~0.1 s + W instead of ~1 s + W (allowed unprivileged).
//   Linux:  -W <s> is the reply timeout (whole seconds on older iputils), -t would set the TTL.
//   BusyBox: no -n / -i support -> automatic fallback to the minimal argument set.

import { execFile } from 'node:child_process';
import net from 'node:net';
import { isValidIpv4 } from './sys.js';

const IS_MAC = process.platform === 'darwin' || process.platform === 'freebsd';
const ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

// Reply line, e.g. 'macOS: 64 bytes from 10.0.0.1: icmp_seq=0 ttl=63 time=3.205 ms'
//                  'Linux: 64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms' / 'time<1 ms'
//                  'BusyBox: 64 bytes from 10.0.0.1: seq=0 ttl=64 time=0.912 ms'
const REPLY_LINE_RE = /bytes from ([0-9.]+)[^\n]*/i;
const TTL_RE = /\bttl=(\d+)/i;
const TIME_RE = /\btime[=<]\s*([\d.]+)\s*ms/i;
const USAGE_RE = /usage|invalid option|illegal option|unrecognized option|bad (?:timing|linger|wait|interval)/i;

// Argument style; downgraded once if the local ping rejects our preferred flags.
let argStyle = 'full'; // 'full' | 'minimal'
let warnedPermission = false;

function buildArgs(ip, timeoutMs, style) {
  const ms = Math.max(100, Math.round(timeoutMs));
  const secs = Math.max(1, Math.ceil(ms / 1000));
  if (IS_MAC) {
    return style === 'full'
      ? ['-c', '1', '-n', '-i', '0.1', '-W', String(ms), '-t', String(secs + 1), ip]
      : ['-c', '1', '-n', '-W', String(ms), '-t', String(secs + 1), ip];
  }
  return style === 'full'
    ? ['-c', '1', '-n', '-W', String(secs), ip]
    : ['-c', '1', '-W', String(secs), ip];
}

function execPing(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: timeoutMs + 2000, env: ENV, maxBuffer: 64 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

/** Parse one ping invocation's stdout. Exported for unit tests. */
export function parsePingOutput(stdout, ip = null) {
  const line = REPLY_LINE_RE.exec(stdout || '');
  if (!line) return { alive: false, rttMs: null, ttl: null };
  // Ignore replies from a different host (e.g. a router answering for a broadcast/odd address).
  if (ip && line[1] !== ip) return { alive: false, rttMs: null, ttl: null };
  const ttl = TTL_RE.exec(line[0]);
  const time = TIME_RE.exec(line[0]);
  const rtt = time ? Number(time[1]) : null;
  return {
    alive: true,
    rttMs: rtt != null && Number.isFinite(rtt) ? Math.round(rtt * 100) / 100 : null,
    ttl: ttl ? Number(ttl[1]) : null,
  };
}

/**
 * Single ICMP echo with a hard deadline.
 * @returns {Promise<{alive:boolean, rttMs:number|null, ttl:number|null}>} never rejects.
 */
export async function ping(ip, { timeoutMs = 1000 } = {}) {
  if (!isValidIpv4(ip)) return { alive: false, rttMs: null, ttl: null };
  const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1000;

  let res = await execPing(buildArgs(ip, t, argStyle), t);
  if (res.err && argStyle === 'full' && USAGE_RE.test(res.stderr)) {
    argStyle = 'minimal';
    console.warn('[pinger] local ping rejected preferred flags; using minimal argument set');
    res = await execPing(buildArgs(ip, t, argStyle), t);
  }
  if (res.err && !warnedPermission && /operation not permitted|permission denied|socket: /i.test(res.stderr)) {
    warnedPermission = true;
    console.warn(`[pinger] ping is not permitted for this user (${res.stderr.trim().split('\n')[0]}). ` +
      'On Linux check net.ipv4.ping_group_range or the cap_net_raw capability on ping.');
  }
  // Exit 0 = reply. Non-zero still may carry a reply line on some builds; trust the parsed line.
  return parsePingOutput(res.stdout, ip);
}

/**
 * Cheap TCP presence check: true when the host completes a handshake OR actively refuses (RST /
 * ECONNREFUSED) on any of `ports` within `timeoutMs`. Used for devices that are in the ARP table but
 * did not answer ping (Wi-Fi power save, ICMP firewalls). Timeouts / unreachable = absent.
 */
export async function tcpPresence(ip, ports, { timeoutMs = 800 } = {}) {
  if (!isValidIpv4(ip) || !Array.isArray(ports) || !ports.length) return false;
  const tryPort = (port) => new Promise((resolve) => {
    let done = false;
    const sock = new net.Socket();
    const finish = (alive) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.on('error', () => {});
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', (err) => finish(err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET'));
    try { sock.connect({ host: ip, port }); } catch { finish(false); }
  });
  for (const port of ports.slice(0, 3)) {
    if (Number.isInteger(port) && port > 0 && port < 65536 && await tryPort(port)) return true;
  }
  return false;
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Periodic latency sampler over a target list (PLAN.md §2.3).
 * Rounds never overlap; the next round starts `intervalMs` after the previous one started
 * (or immediately after it ends if it overran).
 */
export function createPinger({ intervalMs = 10000, timeoutMs = 1000, concurrency = 16, onSample } = {}) {
  /** mac -> ip */
  let targets = new Map();
  let timer = null;
  let running = false;
  let inFlight = null;   // Promise of the round in progress
  let followUp = null;   // Promise of a queued pingNow() round

  function emit(sample) {
    if (typeof onSample !== 'function') return;
    try {
      onSample(sample);
    } catch (err) {
      console.warn(`[pinger] onSample failed: ${err?.message || err}`);
    }
  }

  async function round() {
    const list = [...targets.entries()].map(([mac, ip]) => ({ mac, ip }));
    if (!list.length) return;
    await pool(list, concurrency, async ({ mac, ip }) => {
      let r;
      try {
        r = await ping(ip, { timeoutMs });
      } catch {
        r = { alive: false, rttMs: null, ttl: null };
      }
      // Drop samples for targets removed / re-addressed while the round was running.
      if (targets.get(mac) !== ip) return;
      emit({ mac, ip, alive: r.alive, rttMs: r.alive ? r.rttMs : null, ttl: r.alive ? r.ttl : null, at: new Date().toISOString() });
    });
  }

  function runRound() {
    if (inFlight) return inFlight;
    inFlight = round()
      .catch((err) => console.warn(`[pinger] round failed: ${err?.message || err}`))
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule(delay) {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(tick, Math.max(0, delay));
    timer.unref?.();
  }

  async function tick() {
    if (!running) return;
    const started = Date.now();
    await runRound();
    schedule(intervalMs - (Date.now() - started));
  }

  return {
    /** Replace the target list: Array<{ mac, ip }>. Invalid IPs are ignored. */
    setTargets(list) {
      const next = new Map();
      for (const t of Array.isArray(list) ? list : []) {
        if (t && typeof t.mac === 'string' && isValidIpv4(t.ip)) next.set(t.mac, t.ip);
      }
      targets = next;
    },
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    stop() {
      running = false;
      clearTimeout(timer);
      timer = null;
    },
    /** One round over the current targets now. If a round is running, a single follow-up round is queued. */
    pingNow() {
      if (!inFlight) return runRound();
      if (!followUp) {
        followUp = inFlight.then(() => {
          followUp = null;
          return runRound();
        });
      }
      return followUp;
    },
  };
}
