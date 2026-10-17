// Windows `arp -a` parsing (pure; runs on any OS): `npm --prefix server test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWinArp, parseArpOutput, WIN_MAX_SWEEP_CONCURRENCY } from '../src/net/discovery.js';

const fx = (name) => readFileSync(new URL(`./fixtures/win/${name}`, import.meta.url), 'utf8');

test('win arp: multiple Interface sections; filter to the monitored interface IP', () => {
  const rows = parseWinArp(fx('arp-en-multi.txt'), { ifaceIp: '192.168.0.101' });
  assert.deepEqual(rows, [
    { ip: '192.168.0.1', mac: '20:23:51:ea:0f:f0', iface: '192.168.0.101', permanent: false },
    { ip: '192.168.0.23', mac: '3c:7c:3f:5a:9b:03', iface: '192.168.0.101', permanent: false },
    { ip: '192.168.0.45', mac: 'a6:83:e7:1c:2d:01', iface: '192.168.0.101', permanent: false },
    { ip: '192.168.0.60', mac: 'b8:27:eb:12:34:56', iface: '192.168.0.101', permanent: true },
  ]);
});

test('win arp: broadcast, multicast (01-00-5e), all-zero/invalid and >=224.x rows are skipped', () => {
  const all = parseWinArp(fx('arp-en-multi.txt'));
  const macs = all.map((r) => r.mac);
  assert.ok(!macs.some((m) => m === 'ff:ff:ff:ff:ff:ff' || m.startsWith('01:00:5e') || m === '00:00:00:00:00:00'));
  assert.ok(!all.some((r) => Number(r.ip.split('.')[0]) >= 224));
  // Without a filter, unicast rows of every section are returned, tagged with their section IP.
  assert.deepEqual(all.map((r) => `${r.iface} ${r.ip}`), [
    '192.168.0.101 192.168.0.1', '192.168.0.101 192.168.0.23', '192.168.0.101 192.168.0.45',
    '192.168.0.101 192.168.0.60', '172.27.144.1 172.27.150.3',
  ]);
  const extra = parseWinArp('Interface: 10.0.0.5 --- 0x3\r\n  10.0.0.9   33-33-00-00-00-01   static\r\n  10.0.0.8   00-00-00-00-00-00   invalid\r\n');
  assert.deepEqual(extra, []);
});

test('win arp: German headers (Schnittstelle / dynamisch / statisch)', () => {
  assert.deepEqual(parseWinArp(fx('arp-de.txt'), { ifaceIp: '192.168.178.20' }), [
    { ip: '192.168.178.1', mac: '38:10:d5:aa:bb:cc', iface: '192.168.178.20', permanent: false },
    { ip: '192.168.178.34', mac: 'f0:18:98:01:02:03', iface: '192.168.178.20', permanent: false },
  ]);
});

test('win arp: unknown interface IP or empty output -> no rows', () => {
  assert.deepEqual(parseWinArp(fx('arp-en-multi.txt'), { ifaceIp: '10.9.9.9' }), []);
  assert.deepEqual(parseWinArp('No ARP Entries Found.\r\n'), []);
  assert.deepEqual(parseWinArp(''), []);
  assert.deepEqual(parseWinArp(null), []);
});

test('win arp: French "Interface : <ip>" header with space before the colon', () => {
  const fr = 'Interface : 192.168.1.10 --- 0x9\r\n  Adresse Internet      Adresse physique      Type\r\n  192.168.1.1           e4-9e-12-00-11-22     dynamique\r\n';
  assert.deepEqual(parseWinArp(fr, { ifaceIp: '192.168.1.10' }), [
    { ip: '192.168.1.1', mac: 'e4:9e:12:00:11:22', iface: '192.168.1.10', permanent: false },
  ]);
});

test('unix arp parser unchanged and does not read Windows output', () => {
  const mac = '? (10.0.0.11) at e4:24:6c:7e:8:94 on en0 ifscope [ethernet]\n? (10.0.0.2) at (incomplete) on en0 ifscope [ethernet]\n';
  assert.deepEqual(parseArpOutput(mac), [{ ip: '10.0.0.11', mac: 'e4:24:6c:7e:08:94', iface: 'en0', permanent: false }]);
  assert.deepEqual(parseArpOutput(fx('arp-en-multi.txt')), []);
});

test('Windows sweep concurrency cap', () => {
  assert.equal(WIN_MAX_SWEEP_CONCURRENCY, 32);
});
