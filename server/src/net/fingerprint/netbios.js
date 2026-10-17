/**
 * NetBIOS node-status (NBSTAT) query over UDP 137. Windows machines and Samba
 * servers answer with their NetBIOS names. Pure dgram, no root needed: the
 * request is sent from an ephemeral port and the reply comes back to it.
 */
import dgram from 'node:dgram';

// First-level encoded wildcard name "*" (0x2A followed by 15 NUL bytes).
function encodeWildcardName() {
  const raw = Buffer.alloc(16, 0);
  raw[0] = 0x2a;
  const out = Buffer.alloc(34);
  out[0] = 32;
  for (let i = 0; i < 16; i++) {
    out[1 + i * 2] = 0x41 + (raw[i] >> 4);
    out[2 + i * 2] = 0x41 + (raw[i] & 0x0f);
  }
  out[33] = 0;
  return out;
}

export function buildNodeStatusRequest(txId = Math.floor(Math.random() * 0xffff)) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(txId & 0xffff, 0);
  header.writeUInt16BE(0x0000, 2); // flags: query
  header.writeUInt16BE(1, 4); // QDCOUNT
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(0x0021, 0); // NBSTAT
  tail.writeUInt16BE(0x0001, 2); // IN
  return Buffer.concat([header, encodeWildcardName(), tail]);
}

/** Skip a (possibly compressed) DNS-style name starting at `off`; returns the next offset. */
function skipName(buf, off) {
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2;
    off += len + 1;
  }
  return off;
}

/**
 * Parse an NBSTAT response. Returns
 * { name, group, names: [{name, suffix, group}], mac, samba } or null.
 * `samba` is true when the unit-ID MAC is all zeros, which Samba (Linux/NAS) does
 * and Windows does not.
 */
export function parseNodeStatusResponse(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12 + 1) return null;
    const flags = buf.readUInt16BE(2);
    if ((flags & 0x8000) === 0) return null; // not a response
    const anCount = buf.readUInt16BE(6);
    if (anCount < 1) return null;
    let off = 12;
    // Responses normally carry no question section, but skip it if present.
    const qdCount = buf.readUInt16BE(4);
    for (let i = 0; i < qdCount; i++) off = skipName(buf, off) + 4;
    off = skipName(buf, off);
    if (off + 10 > buf.length) return null;
    const type = buf.readUInt16BE(off);
    if (type !== 0x0021) return null;
    off += 10; // type, class, ttl, rdlength
    const count = buf[off++];
    const names = [];
    for (let i = 0; i < count && off + 18 <= buf.length; i++) {
      const name = buf.toString('latin1', off, off + 15).replace(/[\s\0]+$/, '');
      const suffix = buf[off + 15];
      const nameFlags = buf.readUInt16BE(off + 16);
      names.push({ name, suffix, group: (nameFlags & 0x8000) !== 0 });
      off += 18;
    }
    let mac = null;
    if (off + 6 <= buf.length) {
      mac = Array.from(buf.subarray(off, off + 6), (b) => b.toString(16).padStart(2, '0')).join(':');
    }
    const unique = names.find((n) => !n.group && n.suffix === 0x00 && n.name)
      || names.find((n) => !n.group && n.suffix === 0x20 && n.name)
      || names.find((n) => !n.group && n.name);
    if (!unique) return null;
    const group = names.find((n) => n.group && n.suffix === 0x00 && n.name && n.name !== '__MSBROWSE__');
    return {
      name: unique.name,
      group: group ? group.name : null,
      names,
      mac,
      samba: mac === '00:00:00:00:00:00',
    };
  } catch {
    return null;
  }
}

/**
 * Query the NetBIOS name of `ip`. Resolves to { name, group, mac, samba } or null
 * on timeout / no answer / error. Never rejects; the socket is always closed.
 */
export function queryNetbios(ip, { timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    let socket;
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { socket?.close(); } catch { /* already closed */ }
      resolve(value);
    };
    try {
      socket = dgram.createSocket('udp4');
      const txId = Math.floor(Math.random() * 0xffff);
      socket.on('error', () => finish(null));
      socket.on('message', (msg, rinfo) => {
        if (rinfo.address !== ip || msg.length < 2 || msg.readUInt16BE(0) !== txId) return;
        const parsed = parseNodeStatusResponse(msg);
        if (parsed) finish({ name: parsed.name, group: parsed.group, mac: parsed.mac, samba: parsed.samba });
      });
      timer = setTimeout(() => finish(null), timeoutMs);
      socket.send(buildNodeStatusRequest(txId), 137, ip, (err) => { if (err) finish(null); });
    } catch {
      finish(null);
    }
  });
}
