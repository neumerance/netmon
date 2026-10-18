// Mock router integration (NETMON_MOCK=1): same signatures as router/syslog.js createSyslogReceiver and
// router/snmp.js createSnmpClient + pollRouter, with a simulated generic router. No sockets.
//
// Port names are plain eth0..eth4 (no "WAN" label) so the internet port is found the vendor-neutral way:
// pollRouter reports eth0 as the default route's interface.

import { parseSyslog } from '../router/syslog.js';
import { MOCK_NETWORK } from './devices.js';

const LOG_INTERVAL_MS = 4000;
const LINES = [
  '<30>Oct 18 02:00:01 router dhcpd[812]: DHCPACK on 192.168.1.42 to 5a:1f:3e:8c:44:04',
  '<30>Oct 18 02:00:05 router dhcpd[812]: DHCPACK on 192.168.1.57 to 3c:28:6d:a1:b2:05',
  '<37>Oct 18 02:00:09 router httpd: admin logged in from 192.168.1.23',
  '<30>Oct 18 02:00:13 router netifd: Interface \'wan\' is now up',
  '<36>Oct 18 02:00:17 router firewall: dropped TCP SYN from 185.220.101.4 to port 22',
  '<30>Oct 18 02:00:21 router ntpd[455]: clock synchronized',
];

/** Emits a simulated router log line every few seconds once started. */
export function createSyslogReceiver({ port, accept, onMessage, onDropped }) {
  let timer = null;
  let i = 0;
  return {
    port,
    start() {
      timer = setInterval(() => {
        const address = MOCK_NETWORK.gateway;
        if (!accept(address)) { onDropped?.(address); return; }
        onMessage(parseSyslog(LINES[i++ % LINES.length]), { address, port: 514 });
      }, LOG_INTERVAL_MS);
      timer.unref?.();
      return Promise.resolve();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}

const PORTS = [
  { index: 1, name: 'eth0', speedMbps: 1000, downMbps: 180, upMbps: 22 }, // internet side (default route)
  { index: 2, name: 'eth1', speedMbps: 0, downMbps: 0, upMbps: 0, down: true },
  { index: 3, name: 'eth2', speedMbps: 0, downMbps: 0, upMbps: 0, down: true },
  { index: 4, name: 'eth3', speedMbps: 1000, downMbps: 4, upMbps: 30 },
  { index: 5, name: 'eth4', speedMbps: 1000, downMbps: 18, upMbps: 165 },
];
const DEFAULT_ROUTE_IFINDEX = 1;

/** A client object only; the "community" must be non-empty like the real one. */
export function createSnmpClient({ host, community }) {
  return { host, community, close() {} };
}

const startedAt = Date.now();
const counters = new Map(PORTS.map((p) => [p.index, { in: 10n ** 9n * BigInt(p.index), out: 10n ** 8n * BigInt(p.index), at: startedAt }]));

/** Simulated poll: counters grow at roughly each port's nominal rate with some jitter. */
export async function pollRouter(client) {
  if (client.community === 'wrong') throw Object.assign(new Error(`No SNMP response from ${client.host} (check that SNMP is enabled and the community is right)`), { code: 'timeout' });
  const now = Date.now();
  const interfaces = PORTS.map((p) => {
    const c = counters.get(p.index);
    const dt = (now - c.at) / 1000;
    const jitter = () => 0.6 + Math.random() * 0.8;
    c.in += BigInt(Math.round((p.downMbps * 1e6 * jitter() * dt) / 8));
    c.out += BigInt(Math.round((p.upMbps * 1e6 * jitter() * dt) / 8));
    c.at = now;
    return {
      index: p.index, name: p.name, descr: p.name, alias: null, operStatus: p.down ? 'down' : 'up',
      speedMbps: p.speedMbps || null, inOctets: c.in, outOctets: c.out,
    };
  });
  return {
    system: { name: 'mock-router', descr: 'Simulated router (mock)', uptimeSec: Math.floor((now - startedAt) / 1000) + 2_000_000 },
    interfaces,
    counterBits: 64,
    defaultRouteIfIndex: DEFAULT_ROUTE_IFINDEX,
  };
}
