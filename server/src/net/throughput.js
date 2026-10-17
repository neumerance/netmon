// Live receive / transmit rate of THIS machine's LAN interface from kernel byte counters.
// PLAN.md §2.5. macOS: `netstat -ibn -I <iface>` (the <Link#N> row); Linux: /proc/net/dev.
// One host cannot observe other devices' throughput without router integration, so this is self-only.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const EXEC_OPTS = { timeout: 3000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } };
const IFACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,31}$/;
const MAX_PLAUSIBLE_MBPS = 400000; // anything above is a counter glitch, not traffic

/**
 * Parse `netstat -ibn [-I iface]` output. Rows are one per address with identical counters, so only
 * the `<Link#N>` row is used. Address/Network columns may be missing or truncated, hence the last 7
 * numeric columns are read from the right: Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll.
 */
export function parseNetstatIbn(text, iface) {
  for (const line of String(text || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 9) continue;
    if (f[0] !== iface && f[0] !== `${iface}*`) continue;
    if (!/^<Link#\d+>$/.test(f[2] ?? '')) continue;
    const n = f.slice(-7);
    const rx = Number(n[2]);
    const tx = Number(n[5]);
    if (Number.isFinite(rx) && Number.isFinite(tx)) return { rxBytes: rx, txBytes: tx };
  }
  return null;
}

/** Parse /proc/net/dev. The name can be glued to the first number ('eth0:123'), so split on ':' first. */
export function parseProcNetDev(text, iface) {
  for (const line of String(text || '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0 || line.slice(0, idx).trim() !== iface) continue;
    const f = line.slice(idx + 1).trim().split(/\s+/);
    const rx = Number(f[0]);
    const tx = Number(f[8]);
    if (Number.isFinite(rx) && Number.isFinite(tx)) return { rxBytes: rx, txBytes: tx };
  }
  return null;
}

/**
 * Current byte counters of `ifaceName`.
 * @returns {Promise<{rxBytes:number, txBytes:number, at:number}>} at = ms epoch
 * @throws when the interface is unknown or counters cannot be read
 */
export async function readCounters(ifaceName) {
  if (typeof ifaceName !== 'string' || !IFACE_RE.test(ifaceName)) throw new Error(`invalid interface name: ${ifaceName}`);
  let c = null;
  if (process.platform === 'linux') {
    c = parseProcNetDev(await readFile('/proc/net/dev', 'utf8'), ifaceName);
  } else {
    const { stdout } = await run('netstat', ['-ibn', '-I', ifaceName], EXEC_OPTS);
    c = parseNetstatIbn(stdout, ifaceName);
  }
  if (!c) throw new Error(`interface ${ifaceName} not found`);
  return { ...c, at: Date.now() };
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Polls counters every `intervalMs` and reports Mbps from consecutive deltas, timed with a monotonic
 * clock. The first sample arrives after two successful reads; a negative delta (counter reset /
 * interface restart) or an implausible jump is skipped and the baseline is reset.
 */
export function createThroughputMonitor({ ifaceName, intervalMs = 2000, onSample } = {}) {
  let timer = null;
  let running = false;
  let busy = false;
  let prev = null; // { rxBytes, txBytes, t /* performance.now() */ }
  let lastError = null;

  function emit(sample) {
    if (typeof onSample !== 'function') return;
    try {
      onSample(sample);
    } catch (err) {
      console.warn(`[throughput] onSample failed: ${err?.message || err}`);
    }
  }

  async function poll() {
    if (busy) return; // never stack reads if netstat is slow
    busy = true;
    try {
      const c = await readCounters(ifaceName);
      const t = performance.now();
      lastError = null;
      if (!running) return;
      if (prev) {
        const sec = (t - prev.t) / 1000;
        const dRx = c.rxBytes - prev.rxBytes;
        const dTx = c.txBytes - prev.txBytes;
        if (sec > 0.05 && dRx >= 0 && dTx >= 0) {
          const rxMbps = (dRx * 8) / sec / 1e6;
          const txMbps = (dTx * 8) / sec / 1e6;
          if (rxMbps <= MAX_PLAUSIBLE_MBPS && txMbps <= MAX_PLAUSIBLE_MBPS) {
            emit({ rxMbps: round1(rxMbps), txMbps: round1(txMbps), at: new Date().toISOString() });
          }
        }
      }
      prev = { rxBytes: c.rxBytes, txBytes: c.txBytes, t };
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg !== lastError) console.warn(`[throughput] ${msg}`); // log each distinct error once
      lastError = msg;
      prev = null;
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      prev = null;
      poll();
      timer = setInterval(poll, Math.max(250, intervalMs));
      timer.unref?.();
    },
    stop() {
      running = false;
      clearInterval(timer);
      timer = null;
      prev = null;
    },
  };
}
