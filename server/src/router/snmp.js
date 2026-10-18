/**
 * Minimal SNMPv2c client over plain dgram (no dependencies, no native modules): just enough BER to send
 * GetRequest / GetBulkRequest and read the Response, plus an IF-MIB poll for a router's ports.
 *
 * Counter64 values are returned as BigInt; every other integer type as a Number.
 */
import dgram from 'node:dgram';

// ------------------------------------------------------------------------------------------ BER

const T = {
  INTEGER: 0x02, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06, SEQUENCE: 0x30,
  IP_ADDRESS: 0x40, COUNTER32: 0x41, GAUGE32: 0x42, TIMETICKS: 0x43, OPAQUE: 0x44, COUNTER64: 0x46,
  NO_SUCH_OBJECT: 0x80, NO_SUCH_INSTANCE: 0x81, END_OF_MIB_VIEW: 0x82,
  GET: 0xa0, GET_NEXT: 0xa1, RESPONSE: 0xa2, GET_BULK: 0xa5,
};
export const PDU = { GET: T.GET, GET_NEXT: T.GET_NEXT, GET_BULK: T.GET_BULK, RESPONSE: T.RESPONSE };
const EXCEPTIONS = { [T.NO_SUCH_OBJECT]: 'noSuchObject', [T.NO_SUCH_INSTANCE]: 'noSuchInstance', [T.END_OF_MIB_VIEW]: 'endOfMibView' };
const ERROR_STATUS = ['noError', 'tooBig', 'noSuchName', 'badValue', 'readOnly', 'genErr', 'noAccess', 'wrongType',
  'wrongLength', 'wrongEncoding', 'wrongValue', 'noCreation', 'inconsistentValue', 'resourceUnavailable',
  'commitFailed', 'undoFailed', 'authorizationError', 'notWritable', 'inconsistentName'];

function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(type, value) {
  return Buffer.concat([Buffer.from([type]), encodeLength(value.length), value]);
}

function encodeInteger(n) {
  const bytes = [];
  let v = BigInt(n);
  do { bytes.unshift(Number(v & 0xffn)); v >>= 8n; } while (v !== 0n && v !== -1n);
  // Keep the sign bit right: a positive value whose top bit is set needs a leading 0x00 (and vice versa).
  if (n >= 0 && bytes[0] & 0x80) bytes.unshift(0);
  if (n < 0 && !(bytes[0] & 0x80)) bytes.unshift(0xff);
  return tlv(T.INTEGER, Buffer.from(bytes));
}

export function encodeOid(oid) {
  const parts = String(oid).replace(/^\./, '').split('.').map((p) => Number(p));
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) throw new Error(`Invalid OID "${oid}"`);
  const out = [];
  for (const p of [parts[0] * 40 + parts[1], ...parts.slice(2)]) {
    const sub = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) { sub.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...sub);
  }
  return tlv(T.OID, Buffer.from(out));
}

/** Read one TLV at `off`. Returns { type, start, end, next } (value bytes are buf[start..end)). */
function readTlv(buf, off) {
  if (off + 2 > buf.length) throw new Error('Truncated BER');
  const type = buf[off];
  let len = buf[off + 1];
  let start = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || start + n > buf.length) throw new Error('Bad BER length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
    start += n;
  }
  const end = start + len;
  if (end > buf.length) throw new Error('Truncated BER');
  return { type, start, end, next: end };
}

function decodeSigned(buf, start, end) {
  if (start === end) return 0;
  let v = BigInt(buf[start] & 0x80 ? -1 : 0);
  for (let i = start; i < end; i++) v = (v << 8n) | BigInt(buf[i]);
  return v;
}

function decodeUnsigned(buf, start, end) {
  let v = 0n;
  for (let i = start; i < end; i++) v = (v << 8n) | BigInt(buf[i]);
  return v;
}

export function decodeOid(buf, start, end) {
  if (start >= end) return '';
  const subs = [];
  let v = 0;
  for (let i = start; i < end; i++) {
    v = v * 128 + (buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) { subs.push(v); v = 0; }
  }
  // The first sub-identifier packs the first two arcs: X*40+Y, where X is 0, 1 or 2 (2 takes the rest).
  const x = Math.min(2, Math.floor(subs[0] / 40));
  return [x, subs[0] - x * 40, ...subs.slice(1)].join('.');
}

function decodeValue(buf, t) {
  switch (t.type) {
    case T.INTEGER: return { type: 'Integer', value: Number(decodeSigned(buf, t.start, t.end)) };
    case T.OCTET_STRING: return { type: 'OctetString', value: buf.subarray(t.start, t.end) };
    case T.NULL: return { type: 'Null', value: null };
    case T.OID: return { type: 'OID', value: decodeOid(buf, t.start, t.end) };
    case T.IP_ADDRESS: return { type: 'IpAddress', value: [...buf.subarray(t.start, t.end)].join('.') };
    case T.COUNTER32: return { type: 'Counter32', value: Number(decodeUnsigned(buf, t.start, t.end)) };
    case T.GAUGE32: return { type: 'Gauge32', value: Number(decodeUnsigned(buf, t.start, t.end)) };
    case T.TIMETICKS: return { type: 'TimeTicks', value: Number(decodeUnsigned(buf, t.start, t.end)) };
    case T.COUNTER64: return { type: 'Counter64', value: decodeUnsigned(buf, t.start, t.end) };
    case T.OPAQUE: return { type: 'Opaque', value: buf.subarray(t.start, t.end) };
    default:
      if (EXCEPTIONS[t.type]) return { type: EXCEPTIONS[t.type], value: null, exception: true };
      return { type: `0x${t.type.toString(16)}`, value: buf.subarray(t.start, t.end) };
  }
}

// ------------------------------------------------------------------------------------------ messages

/**
 * Encode an SNMPv2c message. For GetBulk, `a` = non-repeaters and `b` = max-repetitions; otherwise both 0.
 * `varbinds` are OIDs (values are always NULL in a request).
 */
export function encodeRequest({ community, pduType, requestId, oids, a = 0, b = 0 }) {
  const vbs = oids.map((oid) => tlv(T.SEQUENCE, Buffer.concat([encodeOid(oid), tlv(T.NULL, Buffer.alloc(0))])));
  const pdu = tlv(pduType, Buffer.concat([
    encodeInteger(requestId), encodeInteger(a), encodeInteger(b), tlv(T.SEQUENCE, Buffer.concat(vbs)),
  ]));
  return tlv(T.SEQUENCE, Buffer.concat([encodeInteger(1 /* v2c */), tlv(T.OCTET_STRING, Buffer.from(community, 'utf8')), pdu]));
}

/**
 * Decode a message. Returns { version, community, pduType, requestId, errorStatus, errorIndex, varbinds }
 * where varbinds are [{ oid, type, value, exception? }]. Throws on malformed input.
 */
export function decodeMessage(buf) {
  const msg = readTlv(buf, 0);
  if (msg.type !== T.SEQUENCE) throw new Error('Not an SNMP message');
  const ver = readTlv(buf, msg.start);
  const com = readTlv(buf, ver.next);
  const pdu = readTlv(buf, com.next);
  const rid = readTlv(buf, pdu.start);
  const es = readTlv(buf, rid.next);
  const ei = readTlv(buf, es.next);
  const list = readTlv(buf, ei.next);
  const varbinds = [];
  for (let off = list.start; off < list.end;) {
    const vb = readTlv(buf, off);
    const oidT = readTlv(buf, vb.start);
    const valT = readTlv(buf, oidT.next);
    varbinds.push({ oid: decodeOid(buf, oidT.start, oidT.end), ...decodeValue(buf, valT) });
    off = vb.next;
  }
  return {
    version: Number(decodeSigned(buf, ver.start, ver.end)),
    community: buf.subarray(com.start, com.end).toString('utf8'),
    pduType: pdu.type,
    requestId: Number(decodeSigned(buf, rid.start, rid.end)),
    errorStatus: Number(decodeSigned(buf, es.start, es.end)),
    errorIndex: Number(decodeSigned(buf, ei.start, ei.end)),
    varbinds,
  };
}

/** Same encoder for responses (used by tests and the mock agent). `varbinds`: [{ oid, type, value }]. */
export function encodeResponse({ community, requestId, errorStatus = 0, errorIndex = 0, varbinds }) {
  const enc = ({ type, value }) => {
    switch (type) {
      case 'Integer': return encodeInteger(value);
      case 'OctetString': return tlv(T.OCTET_STRING, Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
      case 'OID': return encodeOid(value);
      case 'Counter32': case 'Gauge32': case 'TimeTicks': case 'Counter64': {
        const tag = { Counter32: T.COUNTER32, Gauge32: T.GAUGE32, TimeTicks: T.TIMETICKS, Counter64: T.COUNTER64 }[type];
        const raw = encodeInteger(BigInt(value)); // unsigned values: the leading 0x00 is valid BER here too
        return Buffer.concat([Buffer.from([tag]), raw.subarray(1)]);
      }
      case 'endOfMibView': return tlv(T.END_OF_MIB_VIEW, Buffer.alloc(0));
      case 'noSuchObject': return tlv(T.NO_SUCH_OBJECT, Buffer.alloc(0));
      case 'noSuchInstance': return tlv(T.NO_SUCH_INSTANCE, Buffer.alloc(0));
      default: return tlv(T.NULL, Buffer.alloc(0));
    }
  };
  const vbs = varbinds.map((vb) => tlv(T.SEQUENCE, Buffer.concat([encodeOid(vb.oid), enc(vb)])));
  const pdu = tlv(T.RESPONSE, Buffer.concat([
    encodeInteger(requestId), encodeInteger(errorStatus), encodeInteger(errorIndex), tlv(T.SEQUENCE, Buffer.concat(vbs)),
  ]));
  return tlv(T.SEQUENCE, Buffer.concat([encodeInteger(1), tlv(T.OCTET_STRING, Buffer.from(community, 'utf8')), pdu]));
}

/** Is `oid` strictly inside the subtree rooted at `base`? */
export function oidInSubtree(oid, base) {
  return oid.startsWith(`${base}.`);
}

/** Numeric OID comparison (-1, 0, 1). */
export function compareOids(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return pa.length === pb.length ? 0 : (pa.length < pb.length ? -1 : 1);
}

// ------------------------------------------------------------------------------------------ client

export class SnmpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnmpError';
    this.code = code; // 'timeout' | 'snmp_error' | 'socket' | 'closed'
  }
}

/**
 * @param {object} opts
 * @param {string} opts.host        IPv4 address of the agent
 * @param {string} opts.community   v2c community
 * @param {number} [opts.port=161]
 * @param {number} [opts.timeoutMs=2000]  per attempt
 * @param {number} [opts.retries=1]
 */
export function createSnmpClient({ host, community, port = 161, timeoutMs = 2000, retries = 1 }) {
  let socket = null;
  let closed = false;
  let nextId = Math.floor(Math.random() * 0x3fffffff);
  const pending = new Map(); // requestId -> { resolve, reject, timer }

  function ensureSocket() {
    if (socket) return socket;
    socket = dgram.createSocket('udp4');
    socket.on('message', (buf, rinfo) => {
      if (rinfo.address !== host) return; // only the agent we asked
      let msg;
      try { msg = decodeMessage(buf); } catch { return; }
      if (msg.pduType !== T.RESPONSE) return;
      const p = pending.get(msg.requestId);
      if (!p) return;
      pending.delete(msg.requestId);
      clearTimeout(p.timer);
      if (msg.errorStatus) {
        p.reject(new SnmpError('snmp_error', `Agent returned ${ERROR_STATUS[msg.errorStatus] || `error ${msg.errorStatus}`}`));
      } else {
        p.resolve(msg.varbinds);
      }
    });
    socket.on('error', (err) => {
      for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new SnmpError('socket', err.message)); pending.delete(id); }
    });
    socket.unref?.();
    return socket;
  }

  function send(pduType, oids, a = 0, b = 0) {
    if (closed) return Promise.reject(new SnmpError('closed', 'SNMP client closed'));
    const sock = ensureSocket();
    const attempt = (left) => new Promise((resolve, reject) => {
      nextId = (nextId + 1) & 0x3fffffff;
      const requestId = nextId;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new SnmpError('timeout', `No SNMP response from ${host} (check that SNMP is enabled and the community is right)`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      sock.send(encodeRequest({ community, pduType, requestId, oids, a, b }), port, host, (err) => {
        if (!err) return;
        clearTimeout(timer);
        pending.delete(requestId);
        reject(new SnmpError('socket', err.message));
      });
    }).catch((err) => (err.code === 'timeout' && left > 0 ? attempt(left - 1) : Promise.reject(err)));
    return attempt(retries);
  }

  /** GetRequest. Missing objects come back with `exception` set. */
  const get = (oids) => send(T.GET, oids);
  const getBulk = (oids, maxRepetitions = 20, nonRepeaters = 0) => send(T.GET_BULK, oids, nonRepeaters, maxRepetitions);

  /**
   * Walk several table columns at once with GetBulk. Returns { [column]: Map<index, varbind> } where
   * index is the OID suffix after the column (e.g. '3' for ifIndex 3).
   */
  async function walkColumns(columns, { maxRepetitions = 20, maxRequests = 50 } = {}) {
    const out = Object.fromEntries(columns.map((c) => [c, new Map()]));
    let cursors = columns.map((c) => ({ col: c, oid: c }));
    for (let n = 0; n < maxRequests && cursors.length; n++) {
      const vbs = await getBulk(cursors.map((c) => c.oid), maxRepetitions);
      // GetBulk returns rows interleaved: vb[i] belongs to cursor i % cursors.length.
      const done = new Set();
      vbs.forEach((vb, i) => {
        const cur = cursors[i % cursors.length];
        if (done.has(cur.col)) return;
        if (vb.exception || !oidInSubtree(vb.oid, cur.col) || compareOids(vb.oid, cur.oid) <= 0) { done.add(cur.col); return; }
        out[cur.col].set(vb.oid.slice(cur.col.length + 1), vb);
        cur.oid = vb.oid;
      });
      cursors = cursors.filter((c) => !done.has(c.col));
      if (vbs.length < cursors.length) break; // agent truncated the response; what we have is all we get
    }
    return out;
  }

  function close() {
    closed = true;
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new SnmpError('closed', 'SNMP client closed')); pending.delete(id); }
    if (socket) { try { socket.close(); } catch { /* ignore */ } socket = null; }
  }

  return { get, getBulk, walkColumns, close, host };
}

// ------------------------------------------------------------------------------------------ IF-MIB

export const OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifType: '1.3.6.1.2.1.2.2.1.3',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
  // Default route -> outgoing interface (vendor-neutral way to find the internet-facing port).
  ipRouteIfIndexDefault: '1.3.6.1.2.1.4.21.1.2.0.0.0.0', // RFC 1213 ipRouteIfIndex.0.0.0.0
  inetCidrRouteIfIndex: '1.3.6.1.2.1.4.24.7.1.7', // RFC 4292, indexed by destType.destLen.dest.pfxLen...
};
// inetCidrRouteIfIndex index prefix for the IPv4 default route: type ipv4(1), length 4, 0.0.0.0, prefix length 0.
const INET_DEFAULT_ROUTE_PREFIX = '1.4.0.0.0.0.0.';

/** ifIndex of the router's IPv4 default route, or null when the agent does not expose a route table. */
export async function findDefaultRouteIfIndex(client) {
  try {
    const [vb] = await client.get([OIDS.ipRouteIfIndexDefault]);
    if (vb && !vb.exception && Number.isInteger(vb.value) && vb.value > 0) return vb.value;
  } catch { /* fall through to the newer table */ }
  try {
    const cols = await client.walkColumns([OIDS.inetCidrRouteIfIndex], { maxRequests: 5 });
    for (const [index, vb] of cols[OIDS.inetCidrRouteIfIndex]) {
      if (index.startsWith(INET_DEFAULT_ROUTE_PREFIX) && Number.isInteger(vb.value) && vb.value > 0) return vb.value;
    }
  } catch { /* no route table */ }
  return null;
}
const OPER_STATUS = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };
const SOFTWARE_LOOPBACK = 24; // ifType

const str = (vb) => (vb && !vb.exception && Buffer.isBuffer(vb.value) ? vb.value.toString('utf8').replace(/\0+$/, '').trim() : null);
const num = (vb) => (vb && !vb.exception && vb.value != null ? vb.value : null);

/**
 * One poll of a router: system info + every non-loopback interface with its octet counters, and the
 * interface that carries the default route (null when the agent has no route table).
 * Prefers 64-bit ifHC* counters and falls back to 32-bit ifIn/OutOctets when the agent lacks ifXTable.
 * @returns {Promise<{ system: { name, descr, uptimeSec }, interfaces: object[], counterBits: 64|32,
 *                     defaultRouteIfIndex: number|null }>}
 */
export async function pollRouter(client) {
  const sys = await client.get([OIDS.sysDescr, OIDS.sysUpTime, OIDS.sysName]);
  const system = { descr: str(sys[0]), uptimeSec: num(sys[1]) != null ? Math.floor(num(sys[1]) / 100) : null, name: str(sys[2]) };

  const cols = await client.walkColumns([OIDS.ifDescr, OIDS.ifType, OIDS.ifOperStatus, OIDS.ifSpeed,
    OIDS.ifName, OIDS.ifAlias, OIDS.ifHighSpeed, OIDS.ifHCInOctets, OIDS.ifHCOutOctets]);
  let counterBits = 64;
  let inCol = cols[OIDS.ifHCInOctets];
  let outCol = cols[OIDS.ifHCOutOctets];
  if (!inCol.size) {
    counterBits = 32;
    const legacy = await client.walkColumns([OIDS.ifInOctets, OIDS.ifOutOctets]);
    inCol = legacy[OIDS.ifInOctets];
    outCol = legacy[OIDS.ifOutOctets];
  }

  const interfaces = [];
  for (const [index, descrVb] of cols[OIDS.ifDescr]) {
    if (num(cols[OIDS.ifType].get(index)) === SOFTWARE_LOOPBACK) continue;
    const highSpeed = num(cols[OIDS.ifHighSpeed].get(index));
    const speed = num(cols[OIDS.ifSpeed].get(index));
    const inOctets = num(inCol.get(index));
    const outOctets = num(outCol.get(index));
    interfaces.push({
      index: Number(index),
      name: str(cols[OIDS.ifName].get(index)) || str(descrVb) || `if${index}`,
      descr: str(descrVb),
      alias: str(cols[OIDS.ifAlias].get(index)) || null,
      operStatus: OPER_STATUS[num(cols[OIDS.ifOperStatus].get(index))] || 'unknown',
      speedMbps: highSpeed || (speed ? Math.round(speed / 1e6) : null),
      inOctets: inOctets == null ? null : BigInt(inOctets),
      outOctets: outOctets == null ? null : BigInt(outOctets),
    });
  }
  interfaces.sort((a, b) => a.index - b.index);
  const defaultRouteIfIndex = await findDefaultRouteIfIndex(client);
  return { system, interfaces, counterBits, defaultRouteIfIndex };
}
