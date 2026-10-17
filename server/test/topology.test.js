// Unit tests for core/topology.js (node:test, no dependencies): `npm --prefix server test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wouldCreateCycle, validateTopologyPatch, sanitizeOverrides } from '../src/core/topology.js';

const GW = '00:00:00:00:00:01';
const A = '00:00:00:00:00:0a';
const B = '00:00:00:00:00:0b';
const C = '00:00:00:00:00:0c';
const PHONE = '00:00:00:00:00:10';
const ap = (mac) => ({ mac, category: 'access_point' });
const ov = (parentMac) => ({ parentMac, position: null, updatedAt: '2026-01-01T00:00:00.000Z' });

test('wouldCreateCycle: direct and indirect loops', () => {
  assert.equal(wouldCreateCycle(A, A, {}), true);
  assert.equal(wouldCreateCycle(A, B, { [B]: ov(A) }), true);
  assert.equal(wouldCreateCycle(A, C, { [C]: ov(B), [B]: ov(A) }), true);
  assert.equal(wouldCreateCycle(A, B, { [B]: ov(C) }), false);
  assert.equal(wouldCreateCycle(A, null, { [B]: ov(A) }), false);
});

test('wouldCreateCycle: pre-existing loop not involving mac terminates', () => {
  assert.equal(wouldCreateCycle(A, B, { [B]: ov(C), [C]: ov(B) }), false);
});

test('wouldCreateCycle: with isHubMac, stale links through a missing device are not followed', () => {
  const overrides = { [B]: ov(C), [C]: ov(A) }; // C has left the network
  assert.equal(wouldCreateCycle(A, B, overrides), true); // raw walk
  const present = new Set([A, B]);
  assert.equal(wouldCreateCycle(A, B, overrides, (m) => present.has(m)), false);
});

test('validateTopologyPatch: loop -> 400 cycle', () => {
  const devices = [{ mac: GW, isGateway: true, category: 'router' }, ap(A), ap(B)];
  const r = validateTopologyPatch(A, { parentMac: B }, { devices, overrides: { [B]: ov(A) }, known: true });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.errors.parentMac, 'That would create a loop');
});

test('validateTopologyPatch: stale chain through a departed hub is allowed (matches the map)', () => {
  const devices = [{ mac: GW, isGateway: true, category: 'router' }, ap(A), ap(B)];
  const overrides = { [B]: ov(C), [C]: ov(A) };
  const r = validateTopologyPatch(A, { parentMac: B }, { devices, overrides, known: true });
  assert.deepEqual(r, { ok: true, value: { parentMac: B } });
});

test('validateTopologyPatch: chain through a device that is no longer a hub is not followed', () => {
  const devices = [{ mac: GW, isGateway: true, category: 'router' }, ap(A), ap(B), { mac: C, category: 'speaker' }];
  const overrides = { [B]: ov(C), [C]: ov(A) };
  assert.equal(validateTopologyPatch(A, { parentMac: B }, { devices, overrides, known: true }).ok, true);
});

test('validateTopologyPatch: gateway position rejected, clearing it allowed', () => {
  const devices = [{ mac: GW, isGateway: true, category: 'router' }, ap(A)];
  const bad = validateTopologyPatch(GW, { position: { x: 5, y: 1 } }, { devices, known: true });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.position, 'The gateway cannot be moved');
  assert.equal(validateTopologyPatch(GW, { position: null }, { devices, known: true }).ok, true);
  assert.equal(validateTopologyPatch(PHONE, { position: { x: 5, y: 1 } }, { devices, known: true }).ok, true);
});

test('validateTopologyPatch: unknown -> 404, not a hub -> 400', () => {
  const devices = [{ mac: GW, isGateway: true, category: 'router' }, { mac: PHONE, category: 'phone' }];
  assert.equal(validateTopologyPatch(A, { parentMac: null }, { devices, known: false }).status, 404);
  const r = validateTopologyPatch(A, { parentMac: PHONE }, { devices, known: true });
  assert.equal(r.status, 400);
  assert.match(r.errors.parentMac, /Not an access point/);
});

test('sanitizeOverrides breaks stored loops deterministically', () => {
  const out = sanitizeOverrides({ [A]: ov(B), [B]: ov(A) });
  assert.equal(out[A], undefined); // A closes the loop first (MAC order) and has no position -> dropped
  assert.equal(out[B].parentMac, A);
});
