/**
 * Light TCP connect probe. A port counts as open only when the three-way
 * handshake completes inside `timeoutMs`; refused, reset and timed-out
 * connections all count as closed. No data is sent. Every socket is destroyed.
 */
import net from 'node:net';

export const DEFAULT_PORTS = [22, 53, 80, 139, 443, 445, 548, 631, 1400, 3389, 5000, 5001, 7000, 8008, 8009, 8060, 8080, 9100, 32400, 62078];

/** Human-readable meaning of each probed port (used in evidence strings). */
export const PORT_NAMES = {
  22: 'SSH',
  53: 'DNS',
  80: 'HTTP',
  139: 'NetBIOS',
  443: 'HTTPS',
  445: 'SMB',
  548: 'AFP',
  631: 'IPP',
  1400: 'Sonos',
  3389: 'Remote Desktop',
  5000: 'UPnP / DSM / AirPlay',
  5001: 'Synology DSM',
  7000: 'AirPlay',
  8008: 'Google Cast',
  8009: 'Google Cast',
  8060: 'Roku ECP',
  8080: 'HTTP alt',
  9100: 'raw printing',
  32400: 'Plex',
  62078: 'iOS lockdown',
};

/** Resolve true if a TCP connection to ip:port succeeds within timeoutMs. */
export function isPortOpen(ip, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    let done = false;
    const socket = new net.Socket();
    const finish = (open) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    try {
      socket.connect({ host: ip, port });
    } catch {
      finish(false);
    }
  });
}

/**
 * Probe `ports` on `ip` with bounded concurrency. Resolves to the sorted list of
 * open ports. Never rejects.
 */
export async function probePorts(ip, { ports = DEFAULT_PORTS, timeoutMs = 400, concurrency = 6 } = {}) {
  if (!ip || !Array.isArray(ports) || ports.length === 0) return [];
  const open = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, ports.length)) }, async () => {
    while (next < ports.length) {
      const port = ports[next++];
      try {
        if (await isPortOpen(ip, port, timeoutMs)) open.push(port);
      } catch {
        /* treated as closed */
      }
    }
  });
  await Promise.all(workers);
  return open.sort((a, b) => a - b);
}
