// Windows throughput: Get-NetAdapterStatistics / netstat -e parsers and the long-lived PowerShell
// sampler (driven through a fake spawn so it runs on any OS): `npm --prefix server test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parseWinAdapterStats, parseWinNetstatE, parseNetstatIbn, createThroughputMonitor } from '../src/net/throughput.js';

const fx = (name) => readFileSync(new URL(`./fixtures/win/${name}`, import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Get-NetAdapterStatistics JSON: single object, array, JSON lines, case-insensitive name', () => {
  assert.deepEqual(parseWinAdapterStats(fx('adapter-stats-single.json'), 'Wi-Fi'), { rxBytes: 3995179843, txBytes: 1007548737 });
  assert.deepEqual(parseWinAdapterStats(fx('adapter-stats-array.json'), 'Wi-Fi'), { rxBytes: 3995179843, txBytes: 1007548737 });
  assert.deepEqual(parseWinAdapterStats(fx('adapter-stats-array.json'), 'ethernet'), { rxBytes: 120, txBytes: 340 });
  assert.deepEqual(parseWinAdapterStats(fx('adapter-stats-array.json')), { rxBytes: 120, txBytes: 340 });
  const lines = '{"missing":true}\r\n{"Name":"Ethernet 2","ReceivedBytes":"5","SentBytes":"6"}\r\n';
  assert.deepEqual(parseWinAdapterStats(lines, 'Ethernet 2'), { rxBytes: 5, txBytes: 6 });
});

test('Get-NetAdapterStatistics JSON: missing adapter / error / garbage -> null', () => {
  assert.equal(parseWinAdapterStats(fx('adapter-stats-array.json'), 'WLAN'), null);
  assert.equal(parseWinAdapterStats('{"missing":true}', 'Wi-Fi'), null);
  assert.equal(parseWinAdapterStats('{"error":"Access denied"}', 'Wi-Fi'), null);
  assert.equal(parseWinAdapterStats('{"Name":"Wi-Fi","ReceivedBytes":-1,"SentBytes":2}', 'Wi-Fi'), null);
  assert.equal(parseWinAdapterStats('', 'Wi-Fi'), null);
  assert.equal(parseWinAdapterStats('Get-NetAdapterStatistics : not recognized', 'Wi-Fi'), null);
});

test('netstat -e: Bytes row (English and German), totals over all adapters', () => {
  assert.deepEqual(parseWinNetstatE(fx('netstat-e-en.txt')), { rxBytes: 3995179843, txBytes: 1007548737 });
  assert.deepEqual(parseWinNetstatE(fx('netstat-e-de.txt')), { rxBytes: 812345678, txBytes: 45678901 });
  assert.equal(parseWinNetstatE('Interface Statistics\r\n\r\n   Received   Sent\r\n'), null);
  assert.equal(parseWinNetstatE(''), null);
});

test('macOS netstat -ibn parser unchanged', () => {
  const text = [
    'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
    'en0        1500  <Link#11>   66:f1:f9:c6:02:c2  1234567     0 2000000000   765432     0  300000000     0',
    'en0        1500  10.0.0/24     10.0.0.94          1234567     - 2000000000   765432     -  300000000     -',
  ].join('\n');
  assert.deepEqual(parseNetstatIbn(text, 'en0'), { rxBytes: 2000000000, txBytes: 300000000 });
});

// ---------------------------------------------------------------- fake PowerShell sampler

function makeFakeSpawn() {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; return true; };
    proc.unref = () => {};
    calls.push({ cmd, args, opts, proc });
    return proc;
  };
  return { spawnImpl, calls };
}

test('win monitor: one long-lived sampler, Mbps from line deltas, adapter name via env, stop kills it', async () => {
  const { spawnImpl, calls } = makeFakeSpawn();
  const samples = [];
  const mon = createThroughputMonitor({
    ifaceName: 'Ethernet 2', intervalMs: 2000, onSample: (s) => samples.push(s), platform: 'win32', spawnImpl,
    readNetstatImpl: async () => { throw new Error('netstat must not be used'); },
  });
  mon.start();
  mon.start(); // idempotent
  assert.equal(calls.length, 1);
  const { cmd, args, opts, proc } = calls[0];
  assert.match(cmd, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.equal(args[4], '-EncodedCommand');
  const script = Buffer.from(args[5], 'base64').toString('utf16le');
  assert.match(script, /Get-NetAdapterStatistics/);
  assert.doesNotMatch(script, /Ethernet 2/); // name only travels via env
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.env.NETMON_ADAPTER, 'Ethernet 2');
  assert.equal(opts.env.NETMON_INTERVAL_MS, '2000');
  assert.equal(opts.env.NETMON_PARENT_PID, String(process.pid));

  proc.stdout.write('{"Name":"Ethernet 2","ReceivedBytes":1000000,"SentBytes":500000}\r\n');
  await sleep(120);
  proc.stdout.write('{"Name":"Ethernet 2","ReceivedBytes":2250000,');
  proc.stdout.write('"SentBytes":625000}\r\n'); // split across chunks
  await sleep(10);
  assert.equal(samples.length, 1);
  const s = samples[0];
  // 1.25 MB in ~0.12 s ≈ 80 Mbps rx; 125 kB ≈ 8 Mbps tx (timing jitter tolerated)
  assert.ok(s.rxMbps > 30 && s.rxMbps < 100, `rx ${s.rxMbps}`);
  assert.ok(s.txMbps > 3 && s.txMbps < 10, `tx ${s.txMbps}`);
  assert.ok(Math.abs(s.rxMbps / s.txMbps - 10) < 0.5);

  // counter reset -> skipped, baseline reset, next delta emits again
  proc.stdout.write('{"Name":"Ethernet 2","ReceivedBytes":10,"SentBytes":10}\r\n');
  await sleep(60);
  proc.stdout.write('{"Name":"Ethernet 2","ReceivedBytes":20,"SentBytes":20}\r\n');
  await sleep(10);
  assert.equal(samples.length, 2);

  mon.stop();
  assert.equal(proc.killed, true);
  mon.stop(); // idempotent
});

test('win monitor: sampler crashes 3x -> falls back to netstat -e with a log line', async () => {
  const { spawnImpl, calls } = makeFakeSpawn();
  const warns = [];
  const origWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  let reads = 0;
  const mon = createThroughputMonitor({
    ifaceName: 'Wi-Fi', intervalMs: 250, onSample: () => {}, platform: 'win32', spawnImpl,
    readNetstatImpl: async () => { reads++; return { rxBytes: reads * 1000, txBytes: reads * 100, at: Date.now() }; },
  });
  try {
    mon.start();
    // Three consecutive bad lines without a good sample trigger the fallback immediately.
    calls[0].proc.stdout.write('{"error":"Access denied"}\r\n{"error":"Access denied"}\r\n{"error":"Access denied"}\r\n');
    await sleep(30);
    assert.equal(calls[0].proc.killed, true);
    assert.ok(warns.some((w) => /falling back to `netstat -e`/.test(w)), warns.join('\n'));
    assert.ok(reads >= 1);
    await sleep(300);
    assert.ok(reads >= 2);
    assert.equal(calls.length, 1); // no further PowerShell spawns
  } finally {
    mon.stop();
    console.warn = origWarn;
  }
  const after = reads;
  await sleep(300);
  assert.equal(reads, after); // stopped
});

test('win monitor: sampler exit schedules a restart; spawn error is handled', async () => {
  const { spawnImpl, calls } = makeFakeSpawn();
  const origWarn = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  const mon = createThroughputMonitor({ ifaceName: 'Wi-Fi', intervalMs: 2000, platform: 'win32', spawnImpl, readNetstatImpl: async () => ({ rxBytes: 0, txBytes: 0 }) });
  try {
    mon.start();
    calls[0].proc.stderr.write('Get-NetAdapterStatistics : boom\r\n');
    calls[0].proc.emit('exit', 1, null);
    await sleep(10);
    assert.ok(warns.some((w) => /exited \(1\): Get-NetAdapterStatistics : boom; restarting in 5 s/.test(w)), warns.join('\n'));
    assert.equal(calls.length, 1); // restart is delayed (5 s), not immediate
  } finally {
    mon.stop();
    console.warn = origWarn;
  }
});

test('win monitor: invalid adapter name never spawns', () => {
  const { spawnImpl, calls } = makeFakeSpawn();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const mon = createThroughputMonitor({ ifaceName: 'bad\nname', platform: 'win32', spawnImpl });
    mon.start();
    mon.stop();
    assert.equal(calls.length, 0);
  } finally {
    console.warn = origWarn;
  }
});
