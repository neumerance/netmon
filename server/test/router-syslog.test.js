// Unit tests for router/syslog.js: parser formats, WAN change detection and the UDP receiver's source filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { parseSyslog, detectWanChange, createSyslogReceiver } from '../src/router/syslog.js';

const NOW = new Date(2026, 9, 18, 2, 0, 0).getTime(); // Oct 18 2026, local time

test('RFC 3164 with host and tag', () => {
  const p = parseSyslog('<30>Oct 18 01:59:58 gw dhcpd[812]: DHCP Server allocated IP address 10.0.0.105', NOW);
  assert.equal(p.facility, 3);
  assert.equal(p.severity, 6);
  assert.equal(p.severityName, 'info');
  assert.equal(p.host, 'gw');
  assert.equal(p.app, 'dhcpd');
  assert.equal(p.message, 'DHCP Server allocated IP address 10.0.0.105');
  assert.equal(p.sentAt, new Date(2026, 9, 18, 1, 59, 58).toISOString());
});

test('RFC 3164 from December received in January belongs to last year', () => {
  const p = parseSyslog('<14>Dec 31 23:59:59 gw kernel: hello', new Date(2027, 0, 1, 0, 0, 5).getTime());
  assert.equal(new Date(p.sentAt).getFullYear(), 2026);
});

test('RFC 5424 with structured data', () => {
  const p = parseSyslog('<165>1 2026-10-18T02:00:00.000Z gw webd 99 ID47 [exampleSDID@32473 iut="3"] admin logged in', NOW);
  assert.equal(p.severityName, 'notice');
  assert.equal(p.host, 'gw');
  assert.equal(p.app, 'webd');
  assert.equal(p.message, 'admin logged in');
  assert.equal(p.sentAt, '2026-10-18T02:00:00.000Z');
});

test('bare "<PRI>message" (what many routers send) and ISO timestamps', () => {
  const bare = parseSyslog('<133>192.168.1.23 logged into the web interface successfully.', NOW);
  assert.equal(bare.severityName, 'notice');
  assert.equal(bare.host, null);
  assert.equal(bare.app, null);
  assert.equal(bare.message, '192.168.1.23 logged into the web interface successfully.');

  const iso = parseSyslog('<131>2026-10-18 02:01:02 gw Online Detection: WAN is offline', NOW);
  assert.equal(iso.severityName, 'err');
  assert.equal(iso.host, 'gw');
  assert.equal(iso.message, 'Online Detection: WAN is offline');
});

test('no PRI, control characters and oversize input are handled', () => {
  const p = parseSyslog(`plain line\u0007 with bell${'x'.repeat(5000)}`, NOW);
  assert.equal(p.severityName, 'info');
  assert.equal(p.facility, null);
  assert.ok(!p.message.includes('\u0007'));
  assert.ok(p.message.length <= 2048);
  assert.equal(parseSyslog(Buffer.from('<999>bad pri'), NOW).message, '<999>bad pri');
});

test('detectWanChange recognises vendor-neutral internet-link wording', () => {
  assert.deepEqual(detectWanChange("netifd: Interface 'wan' is now up"), { wan: 'WAN', state: 'up' });
  assert.deepEqual(detectWanChange('pppoe-wan: link down'), { wan: 'WAN', state: 'down' });
  assert.deepEqual(detectWanChange('pppoe0: session terminated'), { wan: 'pppoe0', state: 'down' });
  assert.deepEqual(detectWanChange('ppp0: connection terminated'), { wan: 'ppp0', state: 'down' });
  assert.deepEqual(detectWanChange('Uplink restored'), { wan: 'uplink', state: 'up' });
  assert.deepEqual(detectWanChange('Internet connection lost'), { wan: 'internet', state: 'down' });
  assert.equal(detectWanChange('eth3: link down'), null); // could be any port: not assumed to be the internet side
  assert.deepEqual(detectWanChange('Online Detection: WAN is offline'), { wan: 'WAN', state: 'down' });
  assert.deepEqual(detectWanChange('WAN1 link down'), { wan: 'WAN1', state: 'down' });
  assert.deepEqual(detectWanChange('Port WAN/LAN1 disconnected'), { wan: 'WAN/LAN1', state: 'down' });
  assert.deepEqual(detectWanChange('PPPoE on WAN2 connected'), { wan: 'WAN2', state: 'up' });
  assert.deepEqual(detectWanChange('WAN is online.'), { wan: 'WAN', state: 'up' });
  assert.equal(detectWanChange('DHCP Server allocated IP address 10.0.0.5'), null);
  assert.equal(detectWanChange('WAN settings updated'), null);
  assert.equal(detectWanChange(null), null);
});

test('receiver accepts only the allowed source and parses datagrams', async (t) => {
  const got = [];
  const dropped = [];
  let allowed = '127.0.0.2'; // not us
  const probe = dgram.createSocket('udp4');
  await new Promise((r) => probe.bind(0, '127.0.0.1', r));
  const port = probe.address().port;
  probe.close();

  const rx = createSyslogReceiver({
    port, host: '127.0.0.1', accept: (a) => a === allowed, onMessage: (p, rinfo) => got.push({ p, from: rinfo.address }), onDropped: (a) => dropped.push(a),
  });
  await rx.start();
  const tx = dgram.createSocket('udp4');
  t.after(() => { rx.stop(); tx.close(); });
  const send = (s) => new Promise((r) => tx.send(s, port, '127.0.0.1', r));
  const settle = () => new Promise((r) => setTimeout(r, 50));

  await send('<131>WAN is offline');
  await settle();
  assert.equal(got.length, 0);
  assert.deepEqual(dropped, ['127.0.0.1']);

  allowed = '127.0.0.1';
  await send('<134>WAN is online');
  await settle();
  assert.equal(got.length, 1);
  assert.equal(got[0].p.message, 'WAN is online');
  assert.equal(got[0].from, '127.0.0.1');
});

test('receiver start fails clearly when the port is taken', async (t) => {
  const busy = dgram.createSocket('udp4');
  await new Promise((r) => busy.bind(0, '127.0.0.1', r));
  t.after(() => busy.close());
  const rx = createSyslogReceiver({ port: busy.address().port, host: '127.0.0.1', accept: () => true, onMessage: () => {} });
  await assert.rejects(rx.start(), (err) => err.code === 'EADDRINUSE' && /already in use/.test(err.message));
});
