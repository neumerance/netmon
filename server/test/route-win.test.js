// Windows default route / adapter helpers (pure; runs on any OS): `npm --prefix server test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseWinRoutePrint, parseWinNetRouteJson, ifaceNameForIp, isExcludedIface, powerShellArgs, winSystemBinary,
  winPowerShellPath,
} from '../src/net/sys.js';

const fx = (name) => readFileSync(new URL(`./fixtures/win/${name}`, import.meta.url), 'utf8');

const IFACES = {
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true }],
  Ethernet: [
    { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '20:23:51:ea:0f:f0', internal: false },
    { address: '192.168.0.101', netmask: '255.255.255.0', family: 'IPv4', mac: '20:23:51:ea:0f:f0', internal: false },
  ],
  'Wi-Fi': [{ address: '192.168.0.142', netmask: '255.255.255.0', family: 'IPv4', mac: '3c:7c:3f:5a:9b:04', internal: false }],
  WireGuard: [{ address: '10.66.0.2', netmask: '255.255.255.255', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false }],
};

test('route print: Active Routes, lowest metric first, On-link and Persistent Routes ignored', () => {
  assert.deepEqual(parseWinRoutePrint(fx('route-print-en.txt')), [
    { gateway: '192.168.0.1', ifaceIp: '192.168.0.101', metric: 25 },
    { gateway: '192.168.0.1', ifaceIp: '192.168.0.142', metric: 35 },
  ]);
});

test('route print: German ("Auf Verbindung" on-link, Ständige Routen: Keine)', () => {
  assert.deepEqual(parseWinRoutePrint(fx('route-print-de.txt')), [
    { gateway: '192.168.178.1', ifaceIp: '192.168.178.20', metric: 50 },
  ]);
});

test('route print: no default route / garbage -> []', () => {
  assert.deepEqual(parseWinRoutePrint(fx('route-print-none.txt')), []);
  assert.deepEqual(parseWinRoutePrint(''), []);
  assert.deepEqual(parseWinRoutePrint(null), []);
  assert.deepEqual(parseWinRoutePrint('0.0.0.0 0.0.0.0 999.1.1.1 192.168.0.101 25'), []);
});

test('Get-NetRoute JSON: array, on-link (NextHop 0.0.0.0) dropped, metric = route + interface', () => {
  assert.deepEqual(parseWinNetRouteJson(fx('netroute-array.json')), [
    { gateway: '192.168.0.1', ifaceIp: '192.168.0.101', ifaceAlias: 'Ethernet', metric: 25 },
    { gateway: '192.168.0.1', ifaceIp: '192.168.0.142', ifaceAlias: 'Wi-Fi', metric: 35 },
  ]);
});

test('Get-NetRoute JSON: single object with BOM, scalar IPAddress', () => {
  assert.deepEqual(parseWinNetRouteJson(fx('netroute-single.json')), [
    { gateway: '192.168.178.1', ifaceIp: '192.168.178.20', ifaceAlias: 'Ethernet', metric: 281 },
  ]);
  assert.deepEqual(parseWinNetRouteJson(''), []);
  assert.deepEqual(parseWinNetRouteJson('not json'), []);
  assert.deepEqual(parseWinNetRouteJson('null'), []);
});

test('ifaceNameForIp maps route interface IPs to os.networkInterfaces() names', () => {
  assert.equal(ifaceNameForIp('192.168.0.101', IFACES), 'Ethernet');
  assert.equal(ifaceNameForIp('192.168.0.142', IFACES), 'Wi-Fi');
  assert.equal(ifaceNameForIp('192.168.0.99', IFACES), null);
  assert.equal(ifaceNameForIp('fe80::1', IFACES), null);
  const mapped = parseWinRoutePrint(fx('route-print-en.txt')).map((r) => ifaceNameForIp(r.ifaceIp, IFACES));
  assert.deepEqual(mapped, ['Ethernet', 'Wi-Fi']);
});

test('isExcludedIface(win32): virtual/VPN adapters excluded, real ones kept', () => {
  for (const n of ['Loopback Pseudo-Interface 1', 'vEthernet (WSL)', 'vEthernet (WSL (Hyper-V firewall))', 'vEthernet (Default Switch)',
    'VirtualBox Host-Only Network', 'VMware Network Adapter VMnet8', 'Bluetooth Network Connection', 'Local Area Connection* 10',
    'LAN-Verbindung* 2', 'Tailscale', 'ZeroTier One [8056c2e21c000001]', 'OpenVPN TAP-Windows6', 'NordLynx', 'Teredo Tunneling Pseudo-Interface']) {
    assert.equal(isExcludedIface(n, 'win32'), true, n);
  }
  for (const n of ['Ethernet', 'Ethernet 2', 'Wi-Fi', 'WLAN', 'vEthernet (External)', 'Ethernet-Verbindung', 'イーサネット', '以太网']) {
    assert.equal(isExcludedIface(n, 'win32'), false, n);
  }
});

test('isExcludedIface(darwin/linux) unchanged', () => {
  for (const n of ['utun0', 'awdl0', 'llw0', 'bridge0', 'docker0', 'veth12', 'lo0', 'tailscale0', 'wg0']) assert.equal(isExcludedIface(n, 'darwin'), true, n);
  for (const n of ['en0', 'en1', 'eth0', 'wlan0', 'enp3s0']) assert.equal(isExcludedIface(n, 'linux'), false, n);
  assert.equal(isExcludedIface('', 'darwin'), true);
  assert.equal(isExcludedIface(null, 'win32'), true);
  // Default platform arg is the running OS: en0 is a usable name everywhere.
  assert.equal(isExcludedIface('en0'), false);
});

test('PowerShell argv: -EncodedCommand carries UTF-16LE script with UTF-8 output prelude', () => {
  const args = powerShellArgs("Write-Output 'hi'");
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  const script = Buffer.from(args[5], 'base64').toString('utf16le');
  assert.match(script, /^\$ProgressPreference='SilentlyContinue';/);
  assert.match(script, /\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8/);
  assert.ok(script.endsWith("Write-Output 'hi'"));
});

test('Windows binaries resolve under %SystemRoot%\\System32', () => {
  const prev = process.env.SystemRoot;
  process.env.SystemRoot = 'D:\\Win';
  try {
    assert.equal(winSystemBinary('PING.EXE'), 'D:\\Win\\System32\\PING.EXE');
    assert.equal(winPowerShellPath(), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  } finally {
    if (prev === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = prev;
  }
});
