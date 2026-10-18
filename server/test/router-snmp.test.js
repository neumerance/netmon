// Unit tests for router/snmp.js: BER round trips and a real UDP exchange with a fake SNMPv2c agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import {
  encodeOid, decodeOid, encodeRequest, decodeMessage, encodeResponse, compareOids, oidInSubtree,
  createSnmpClient, pollRouter, OIDS, PDU,
} from '../src/router/snmp.js';

test('OIDs round-trip, including multi-byte sub-identifiers', () => {
  for (const oid of ['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.31.1.1.1.6.3', '1.3.6.1.4.1.11863.6.10.1', '2.999.3']) {
    const buf = encodeOid(oid);
    assert.equal(buf[0], 0x06);
    assert.equal(decodeOid(buf, 2, buf.length), oid);
  }
  assert.throws(() => encodeOid('1'), /Invalid OID/);
});

test('request encodes as SNMPv2c and decodes back', () => {
  const buf = encodeRequest({ community: 'c0mm', pduType: PDU.GET_BULK, requestId: 4242, oids: [OIDS.ifDescr, OIDS.ifName], a: 0, b: 25 });
  const msg = decodeMessage(buf);
  assert.equal(msg.version, 1);
  assert.equal(msg.community, 'c0mm');
  assert.equal(msg.pduType, PDU.GET_BULK);
  assert.equal(msg.requestId, 4242);
  assert.equal(msg.errorIndex, 25); // max-repetitions travels in the error-index slot
  assert.deepEqual(msg.varbinds.map((v) => v.oid), [OIDS.ifDescr, OIDS.ifName]);
});

test('response values decode with the right types (Counter64 as BigInt)', () => {
  const big = 2n ** 63n + 12345n;
  const buf = encodeResponse({
    community: 'x', requestId: 7, varbinds: [
      { oid: '1.3.6.1.2.1.1.5.0', type: 'OctetString', value: 'gw' },
      { oid: '1.3.6.1.2.1.1.3.0', type: 'TimeTicks', value: 4_294_967_295 },
      { oid: '1.3.6.1.2.1.31.1.1.1.6.1', type: 'Counter64', value: big },
      { oid: '1.3.6.1.2.1.2.2.1.8.1', type: 'Integer', value: 2 },
      { oid: '1.3.6.1.2.1.2.2.1.8.2', type: 'Integer', value: -129 },
      { oid: '1.3.6.1.2.1.2.2.1.8.9', type: 'noSuchInstance' },
    ],
  });
  const [name, ticks, ctr, st, neg, missing] = decodeMessage(buf).varbinds;
  assert.equal(name.value.toString(), 'gw');
  assert.equal(ticks.value, 4_294_967_295);
  assert.equal(ctr.type, 'Counter64');
  assert.equal(ctr.value, big);
  assert.equal(st.value, 2);
  assert.equal(neg.value, -129);
  assert.equal(missing.exception, true);
});

test('OID ordering helpers compare numerically', () => {
  assert.equal(compareOids('1.3.6.1.2.1.2.2.1.2.10', '1.3.6.1.2.1.2.2.1.2.9'), 1);
  assert.equal(compareOids('1.3.6.1', '1.3.6.1.0'), -1);
  assert.equal(oidInSubtree('1.3.6.1.2.1.2.2.1.2.1', OIDS.ifDescr), true);
  assert.equal(oidInSubtree('1.3.6.1.2.1.2.2.1.3.1', OIDS.ifDescr), false);
});

// ------------------------------------------------------------------------------------------ fake agent

/** Minimal SNMPv2c agent over a sorted OID table. Answers Get and GetBulk for one community. */
async function startAgent({ community, table, maxPerResponse = Infinity }) {
  const entries = Object.entries(table).map(([oid, v]) => ({ oid, ...v })).sort((a, b) => compareOids(a.oid, b.oid));
  const next = (oid) => entries.find((e) => compareOids(e.oid, oid) > 0) || null;
  const sock = dgram.createSocket('udp4');
  const requests = [];
  sock.on('message', (buf, rinfo) => {
    const req = decodeMessage(buf);
    requests.push(req);
    if (req.community !== community) return; // wrong community: silence, like a real agent
    let varbinds;
    if (req.pduType === PDU.GET) {
      varbinds = req.varbinds.map(({ oid }) => (table[oid] ? { oid, ...table[oid] } : { oid, type: 'noSuchObject' }));
    } else {
      const maxRep = req.errorIndex;
      const cursors = req.varbinds.map((v) => v.oid);
      varbinds = [];
      for (let r = 0; r < maxRep && varbinds.length < maxPerResponse; r++) {
        cursors.forEach((cur, i) => {
          const e = cur ? next(cur) : null;
          cursors[i] = e ? e.oid : null;
          varbinds.push(e ? { oid: e.oid, type: e.type, value: e.value } : { oid: cur || '1.3', type: 'endOfMibView' });
        });
      }
    }
    sock.send(encodeResponse({ community, requestId: req.requestId, varbinds }), rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve));
  return { port: sock.address().port, requests, close: () => sock.close() };
}

function routerTable({ hc = true, inOctets = [1000n, 0n, 5000n], route = null } = {}) {
  const t = {
    [OIDS.sysDescr]: { type: 'OctetString', value: 'Generic router' },
    [OIDS.sysUpTime]: { type: 'TimeTicks', value: 123456 },
    [OIDS.sysName]: { type: 'OctetString', value: 'gw' },
  };
  // route: 'legacy' = RFC 1213 ipRouteIfIndex.0.0.0.0, 'inet' = RFC 4292 inetCidrRouteTable only.
  if (route === 'legacy') t[OIDS.ipRouteIfIndexDefault] = { type: 'Integer', value: 3 };
  if (route === 'inet') {
    t[`${OIDS.inetCidrRouteIfIndex}.1.4.10.0.0.0.24.2.0.0.1.4.0.0.0.0`] = { type: 'Integer', value: 4 }; // LAN route
    t[`${OIDS.inetCidrRouteIfIndex}.1.4.0.0.0.0.0.2.0.0.1.4.192.168.100.1`] = { type: 'Integer', value: 3 }; // default
  }
  const ifs = [
    { i: 1, name: 'lo', type: 24, status: 1 },
    { i: 2, name: 'eth0', alias: 'WAN', type: 6, status: 1, high: 1000 },
    { i: 3, name: 'eth1', alias: 'WAN/LAN1', type: 6, status: 2, high: 0 },
    { i: 4, name: 'eth3', alias: 'LAN', type: 6, status: 1, high: 1000 },
  ];
  ifs.forEach((f, k) => {
    t[`${OIDS.ifDescr}.${f.i}`] = { type: 'OctetString', value: f.name };
    t[`${OIDS.ifType}.${f.i}`] = { type: 'Integer', value: f.type };
    t[`${OIDS.ifSpeed}.${f.i}`] = { type: 'Gauge32', value: (f.high || 0) * 1_000_000 };
    t[`${OIDS.ifOperStatus}.${f.i}`] = { type: 'Integer', value: f.status };
    t[`${OIDS.ifInOctets}.${f.i}`] = { type: 'Counter32', value: 77 };
    t[`${OIDS.ifOutOctets}.${f.i}`] = { type: 'Counter32', value: 88 };
    if (hc) {
      t[`${OIDS.ifName}.${f.i}`] = { type: 'OctetString', value: f.name };
      if (f.alias) t[`${OIDS.ifAlias}.${f.i}`] = { type: 'OctetString', value: f.alias };
      t[`${OIDS.ifHighSpeed}.${f.i}`] = { type: 'Gauge32', value: f.high || 0 };
      t[`${OIDS.ifHCInOctets}.${f.i}`] = { type: 'Counter64', value: inOctets[k - 1] ?? 0n };
      t[`${OIDS.ifHCOutOctets}.${f.i}`] = { type: 'Counter64', value: 2n ** 40n };
    }
  });
  return t;
}

test('pollRouter reads system info and non-loopback ports with 64-bit counters', async (t) => {
  const agent = await startAgent({ community: 'ro-secret', table: routerTable(), maxPerResponse: 7 });
  const client = createSnmpClient({ host: '127.0.0.1', port: agent.port, community: 'ro-secret', timeoutMs: 500 });
  t.after(() => { client.close(); agent.close(); });

  const res = await pollRouter(client);
  assert.equal(res.counterBits, 64);
  assert.equal(res.defaultRouteIfIndex, null); // this agent publishes no route table
  assert.deepEqual(res.system, { descr: 'Generic router', uptimeSec: 1234, name: 'gw' });
  assert.deepEqual(res.interfaces.map((i) => [i.index, i.name, i.alias, i.operStatus, i.speedMbps]), [
    [2, 'eth0', 'WAN', 'up', 1000],
    [3, 'eth1', 'WAN/LAN1', 'down', null],
    [4, 'eth3', 'LAN', 'up', 1000],
  ]);
  assert.equal(res.interfaces[0].inOctets, 1000n);
  assert.equal(res.interfaces[0].outOctets, 2n ** 40n);
  // Small responses force several GetBulk rounds; all of them used the configured community.
  assert.ok(agent.requests.length > 3);
  assert.ok(agent.requests.every((r) => r.community === 'ro-secret'));
});

test('pollRouter falls back to 32-bit counters without ifXTable', async (t) => {
  const agent = await startAgent({ community: 'c', table: routerTable({ hc: false }) });
  const client = createSnmpClient({ host: '127.0.0.1', port: agent.port, community: 'c', timeoutMs: 500 });
  t.after(() => { client.close(); agent.close(); });

  const res = await pollRouter(client);
  assert.equal(res.counterBits, 32);
  assert.equal(res.interfaces[0].name, 'eth0'); // ifDescr when ifName is missing
  assert.equal(res.interfaces[0].inOctets, 77n);
  assert.equal(res.interfaces[0].speedMbps, 1000); // from ifSpeed
});

test('the default route identifies the internet port (RFC 1213 and RFC 4292 tables)', async (t) => {
  for (const route of ['legacy', 'inet']) {
    const agent = await startAgent({ community: 'c', table: routerTable({ route }) });
    const client = createSnmpClient({ host: '127.0.0.1', port: agent.port, community: 'c', timeoutMs: 500 });
    t.after(() => { client.close(); agent.close(); });
    assert.equal((await pollRouter(client)).defaultRouteIfIndex, 3, route);
  }
});

test('a wrong community times out with a helpful error', async (t) => {
  const agent = await startAgent({ community: 'right', table: routerTable() });
  const client = createSnmpClient({ host: '127.0.0.1', port: agent.port, community: 'wrong', timeoutMs: 150, retries: 1 });
  t.after(() => { client.close(); agent.close(); });

  await assert.rejects(pollRouter(client), (err) => err.code === 'timeout' && /community/.test(err.message));
  assert.equal(agent.requests.length, 2); // one retry
});

test('closing the client rejects pending requests', async () => {
  const client = createSnmpClient({ host: '127.0.0.1', port: 9, community: 'c', timeoutMs: 5000 });
  const p = client.get([OIDS.sysName]);
  client.close();
  await assert.rejects(p, (err) => err.code === 'closed');
});
