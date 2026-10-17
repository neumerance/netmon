// Live receive / transmit rate of THIS machine's LAN interface from kernel byte counters.
// PLAN.md §2.5. macOS: `netstat -ibn -I <iface>` (the <Link#N> row); Linux: /proc/net/dev;
// Windows: PowerShell Get-NetAdapterStatistics (long-lived sampler), fallback `netstat -e`.
// One host cannot observe other devices' throughput without router integration, so this is self-only.

import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { winSystemBinary, winPowerShellPath, powerShellArgs, runPowerShell } from './sys.js';

const run = promisify(execFile);
// windowsHide is ignored on POSIX; on Windows it stops console windows flashing.
const EXEC_OPTS = { timeout: 3000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, windowsHide: true };
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

// ------------------------------------------------------------------------------------------------
// Windows
//
// Per-adapter counters come from PowerShell `Get-NetAdapterStatistics` (adapter Name == the
// os.networkInterfaces() key, e.g. 'Wi-Fi'). Starting powershell.exe costs ~0.3–1.5 s of CPU, so the
// monitor does NOT spawn it per sample: it runs ONE long-lived PowerShell loop that prints a JSON line
// every intervalMs and exits by itself when this process is gone. If that loop cannot run (no NetAdapter
// module, access denied, adapter not listed, repeated crashes) the monitor falls back to polling
// `netstat -e` (~20 ms per call), whose Bytes row is the total over ALL adapters, with a log line.
// ------------------------------------------------------------------------------------------------

const WIN_IFACE_RE = /^[^\x00-\x1f\x7f]{1,256}$/; // friendly names may contain spaces, () and non-ASCII
const WIN_STREAM_MAX_FAILURES = 3;
const WIN_STREAM_RESTART_MS = 5000;

function toCounter(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse Get-NetAdapterStatistics JSON (one object, an array, or JSON lines) for adapter `name`
 * (case-insensitive, like Windows; null = first row). Lines like {"missing":true} / {"error":"..."} -> null.
 */
export function parseWinAdapterStats(text, name = null) {
  const rows = [];
  const push = (d) => { for (const r of Array.isArray(d) ? d : [d]) if (r && typeof r === 'object') rows.push(r); };
  const src = String(text || '').replace(/^﻿/, '').trim();
  if (!src) return null;
  try {
    push(JSON.parse(src));
  } catch {
    for (const line of src.split(/\r?\n/)) {
      try { push(JSON.parse(line.trim())); } catch { /* not JSON */ }
    }
  }
  const want = typeof name === 'string' ? name.toLowerCase() : null;
  for (const r of rows) {
    if (want != null && String(r.Name ?? '').toLowerCase() !== want) continue;
    const rx = toCounter(r.ReceivedBytes);
    const tx = toCounter(r.SentBytes);
    if (rx != null && tx != null) return { rxBytes: rx, txBytes: tx };
  }
  return null;
}

/**
 * Parse `netstat -e`. The Bytes row is the first row with a label and exactly two integers (labels are
 * localized: 'Bytes', 'Octets', ...; the layout is not). Totals over all adapters.
 */
export function parseWinNetstatE(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*\D*?[^\d\s]\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) return { rxBytes: Number(m[1]), txBytes: Number(m[2]) };
  }
  return null;
}

// One-shot read for readCounters(). The name travels in an environment variable, never in the script
// text, and is compared with -eq (Get-NetAdapterStatistics -Name would treat [ ] * as wildcards).
const WIN_STATS_ONCE_PS =
  'Get-NetAdapterStatistics -ErrorAction Stop | Where-Object { $_.Name -eq $env:NETMON_ADAPTER } | ' +
  'Select-Object -First 1 -Property Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress';

// Long-lived sampler for the monitor: one JSON line per interval; exits when the parent pid is gone.
const WIN_STATS_STREAM_PS =
  '$n=$env:NETMON_ADAPTER;$ms=[int]$env:NETMON_INTERVAL_MS;$pp=[int]$env:NETMON_PARENT_PID;' +
  'while($true){' +
  'if($pp -and -not (Get-Process -Id $pp -ErrorAction SilentlyContinue)){exit 0};' +
  'try{$s=@(Get-NetAdapterStatistics -ErrorAction Stop | Where-Object { $_.Name -eq $n } | Select-Object -First 1 -Property Name,ReceivedBytes,SentBytes);' +
  "if($s.Count){$l=ConvertTo-Json -InputObject $s[0] -Compress}else{$l='{\"missing\":true}'}}" +
  'catch{$l=ConvertTo-Json -InputObject @{error=[string]$_.Exception.Message} -Compress};' +
  '[Console]::Out.WriteLine($l);[Console]::Out.Flush();Start-Sleep -Milliseconds $ms}';

async function readWinNetstatCounters() {
  const { stdout } = await run(winSystemBinary('NETSTAT.EXE'), ['-e'], EXEC_OPTS);
  const c = parseWinNetstatE(stdout);
  if (!c) throw new Error('netstat -e: no Bytes row');
  return { ...c, at: Date.now() };
}

async function readWinCounters(ifaceName) {
  let psErr = null;
  try {
    const out = await runPowerShell(WIN_STATS_ONCE_PS, { env: { NETMON_ADAPTER: ifaceName } });
    const c = parseWinAdapterStats(out, ifaceName);
    if (c) return { ...c, at: Date.now(), source: 'Get-NetAdapterStatistics' };
    psErr = new Error(`adapter ${ifaceName} not listed by Get-NetAdapterStatistics`);
  } catch (err) {
    psErr = err;
  }
  try {
    return { ...(await readWinNetstatCounters()), source: 'netstat -e' };
  } catch (err) {
    throw new Error(`interface ${ifaceName}: ${psErr?.message || psErr}; ${err?.message || err}`);
  }
}

/**
 * Current byte counters of `ifaceName`.
 * Windows: Get-NetAdapterStatistics (one PowerShell spawn), else `netstat -e` totals; `source` says which.
 * @returns {Promise<{rxBytes:number, txBytes:number, at:number}>} at = ms epoch
 * @throws when the interface is unknown or counters cannot be read
 */
export async function readCounters(ifaceName) {
  if (process.platform === 'win32') {
    if (typeof ifaceName !== 'string' || !WIN_IFACE_RE.test(ifaceName)) throw new Error(`invalid interface name: ${ifaceName}`);
    return readWinCounters(ifaceName);
  }
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
 * Windows: counters arrive from one long-lived PowerShell sampler (see above) instead of a poll; the
 * delta logic is identical.
 */
export function createThroughputMonitor({
  ifaceName, intervalMs = 2000, onSample,
  // Test hooks (unit tests drive the Windows sampler on any OS); core never passes these.
  platform = process.platform, spawnImpl = spawn, readNetstatImpl = readWinNetstatCounters,
} = {}) {
  let timer = null;
  let running = false;
  let busy = false;
  let prev = null; // { rxBytes, txBytes, t /* performance.now() */ }
  let lastError = null;
  const isWin = platform === 'win32';

  function emit(sample) {
    if (typeof onSample !== 'function') return;
    try {
      onSample(sample);
    } catch (err) {
      console.warn(`[throughput] onSample failed: ${err?.message || err}`);
    }
  }

  /** Feed one counter reading taken at monotonic time `t`. */
  function ingest(c, t) {
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
  }

  function fail(err) {
    const msg = err?.message || String(err);
    if (msg !== lastError) console.warn(`[throughput] ${msg}`); // log each distinct error once
    lastError = msg;
    prev = null;
  }

  async function poll(read = readCounters) {
    if (busy) return; // never stack reads if netstat is slow
    busy = true;
    try {
      const c = await read(ifaceName);
      const t = performance.now();
      lastError = null;
      if (!running) return;
      ingest(c, t);
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------- Windows sampler
  let child = null;
  let restartTimer = null;
  let failures = 0;     // consecutive sampler failures (crash / bad lines) without a good sample
  let winMode = 'stream'; // 'stream' | 'netstat'

  function killChild() {
    if (!child) return;
    const c = child;
    child = null;
    c.removeAllListeners();
    c.stdout?.removeAllListeners();
    c.stderr?.removeAllListeners();
    c.on('error', () => {});
    try { c.kill(); } catch { /* already gone */ }
  }

  function switchToNetstat(reason) {
    killChild();
    clearTimeout(restartTimer);
    restartTimer = null;
    if (winMode === 'netstat' || !running) return;
    winMode = 'netstat';
    prev = null;
    console.warn(`[throughput] Get-NetAdapterStatistics sampler unavailable for '${ifaceName}' (${reason}); ` +
      'falling back to `netstat -e`, which reports the total of ALL adapters');
    poll(readNetstatImpl);
    timer = setInterval(() => poll(readNetstatImpl), Math.max(250, intervalMs));
    timer.unref?.();
  }

  function streamFailed(reason) {
    if (!running || winMode !== 'stream') return;
    killChild();
    prev = null;
    failures++;
    if (failures >= WIN_STREAM_MAX_FAILURES) { switchToNetstat(reason); return; }
    fail(new Error(`PowerShell sampler: ${reason}; restarting in ${WIN_STREAM_RESTART_MS / 1000} s`));
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startStream, WIN_STREAM_RESTART_MS);
    restartTimer.unref?.();
  }

  function onLine(line) {
    if (!running || !line.trim()) return;
    let d;
    try { d = JSON.parse(line); } catch { return; } // stray non-JSON output
    const c = parseWinAdapterStats(line, ifaceName);
    if (c) {
      failures = 0;
      lastError = null;
      ingest(c, performance.now());
      return;
    }
    prev = null;
    failures++;
    const reason = d?.error ? String(d.error) : d?.missing ? `adapter '${ifaceName}' not listed` : 'unexpected output';
    if (failures >= WIN_STREAM_MAX_FAILURES) switchToNetstat(reason);
    else fail(new Error(`PowerShell sampler: ${reason}`));
  }

  function startStream() {
    restartTimer = null;
    if (!running || winMode !== 'stream') return;
    let proc;
    try {
      proc = spawnImpl(winPowerShellPath(), powerShellArgs(WIN_STATS_STREAM_PS), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NETMON_ADAPTER: ifaceName,
          NETMON_INTERVAL_MS: String(Math.max(250, Math.round(intervalMs))),
          NETMON_PARENT_PID: String(process.pid),
        },
      });
    } catch (err) {
      streamFailed(err?.message || String(err));
      return;
    }
    child = proc;
    let buf = '';
    let errTail = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (child === proc) onLine(line);
      }
      if (buf.length > 64 * 1024) buf = '';
    });
    proc.stderr.on('data', (chunk) => { errTail = (errTail + chunk).slice(-500); });
    proc.on('error', (err) => { if (child === proc) streamFailed(err?.message || String(err)); });
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      const why = errTail.trim().split(/\r?\n/).filter(Boolean).pop();
      streamFailed(`exited (${signal || code})${why ? `: ${why}` : ''}`);
    });
    // Never keep the Node process alive just for the sampler (all other timers are unref'd too).
    proc.unref?.();
    proc.stdout.unref?.();
    proc.stderr.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      prev = null;
      if (isWin) {
        if (typeof ifaceName !== 'string' || !WIN_IFACE_RE.test(ifaceName)) {
          fail(new Error(`invalid interface name: ${ifaceName}`));
          return;
        }
        failures = 0;
        if (winMode === 'netstat') {
          winMode = 'stream';
          switchToNetstat('previous sampler failures');
        } else {
          startStream();
        }
        return;
      }
      poll();
      timer = setInterval(poll, Math.max(250, intervalMs));
      timer.unref?.();
    },
    stop() {
      running = false;
      clearInterval(timer);
      timer = null;
      clearTimeout(restartTimer);
      restartTimer = null;
      killChild();
      prev = null;
    },
  };
}
