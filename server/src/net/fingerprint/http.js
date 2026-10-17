/**
 * Light HTTP banner probe (active fingerprinting only). Fetches "/" from a port
 * that the TCP probe found open, reads at most 64 KB, and extracts the Server
 * header, WWW-Authenticate realm and <title>. Signature rules turn those into
 * Hints. Follows at most one redirect, and only to the same host.
 * TLS certificates are not verified: LAN admin pages use self-signed certs and
 * nothing sensitive is sent.
 */
import http from 'node:http';
import https from 'node:https';

const MAX_BODY = 64 * 1024;

function requestOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let req;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { req?.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      req = mod.request(u, {
        method: 'GET',
        headers: { 'User-Agent': 'NetMon/1.0 (device identification)', Accept: 'text/html,*/*;q=0.5', Connection: 'close' },
        rejectUnauthorized: false,
        agent: false,
        // Embedded web servers often send malformed headers (e.g. Content-Length + chunked).
        insecureHTTPParser: true,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= MAX_BODY) chunks.push(c);
          else finish(build());
        });
        res.on('end', () => finish(build()));
        res.on('error', () => finish(build()));
        function build() {
          return {
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
          };
        }
      });
      req.on('error', () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

/** Extract banner info from a raw response. */
export function parseHttpResponse(res, port) {
  if (!res) return null;
  const h = res.headers || {};
  const title = /<title[^>]*>([^<]{0,160})<\/title>/i.exec(res.body || '');
  const realm = /realm="?([^",]+)"?/i.exec(String(h['www-authenticate'] || ''));
  return {
    port,
    status: res.status,
    server: h.server ? String(h.server).slice(0, 120) : null,
    realm: realm ? realm[1].trim().slice(0, 80) : null,
    title: title ? title[1].replace(/\s+/g, ' ').trim() || null : null,
    location: h.location ? String(h.location).slice(0, 200) : null,
    body: (res.body || '').slice(0, 16384),
  };
}

/**
 * Probe the first web port that is open. Resolves to an HttpInfo object
 * ({ port, status, server, realm, title, location, body }) or null. Never rejects.
 */
export async function probeHttp(ip, openPorts, { timeoutMs = 1500 } = {}) {
  try {
    const ports = Array.isArray(openPorts) ? openPorts : [];
    const port = [80, 8080, 443].find((p) => ports.includes(p));
    if (!port) return null;
    const scheme = port === 443 ? 'https' : 'http';
    const base = `${scheme}://${ip}${port === 80 || port === 443 ? '' : `:${port}`}/`;
    let res = await requestOnce(base, timeoutMs);
    let info = parseHttpResponse(res, port);
    if (info && info.status >= 300 && info.status < 400 && info.location) {
      try {
        const next = new URL(info.location, base);
        if (next.hostname === ip && (next.protocol === 'http:' || next.protocol === 'https:')) {
          res = await requestOnce(next.toString(), timeoutMs);
          const followed = parseHttpResponse(res, Number(next.port) || (next.protocol === 'https:' ? 443 : 80));
          if (followed) info = { ...followed, server: followed.server || info.server, realm: followed.realm || info.realm };
        }
      } catch { /* keep first response */ }
    }
    return info;
  } catch {
    return null;
  }
}

// [regex, hint, scope]: scope 'head' tests "server | realm | title" only; 'all' also the body
// (used only for distinctive asset paths, so random page text cannot match).
const SIGNATURES = [
  [/dui\.password\.js|jsBase\/widget|DNVRS-Webs|Dahua/i, { category: 'camera', manufacturer: 'Dahua', weight: 0.75, evidence: 'Web UI → Dahua camera / NVR' }, 'all'],
  [/Hikvision|App-webs|DVRDVS-Webs|Hikvision-Webs|doc\/page\/login\.asp/i, { category: 'camera', manufacturer: 'Hikvision', weight: 0.75, evidence: 'Web UI → Hikvision camera / NVR' }, 'all'],
  [/reolink|amcrest|axis communications|netsurveillance|ip ?camera|network camera|webcam|\b(NVR|DVR)\b/i, { category: 'camera', weight: 0.65, evidence: 'Web UI → camera / video recorder' }],
  [/Pi-hole/i, { category: 'server', os: 'linux', model: 'Pi-hole', weight: 0.7, evidence: 'Web UI → Pi-hole' }],
  [/Home Assistant/i, { category: 'server', os: 'linux', model: 'Home Assistant', weight: 0.7, evidence: 'Web UI → Home Assistant' }],
  [/Proxmox/i, { category: 'server', os: 'linux', model: 'Proxmox VE', weight: 0.7, evidence: 'Web UI → Proxmox' }],
  [/TrueNAS|FreeNAS|Unraid|OpenMediaVault/i, { category: 'nas', os: 'linux', weight: 0.75, evidence: 'Web UI → NAS' }],
  [/Synology|DiskStation/i, { category: 'nas', os: 'linux', weight: 0.75, evidence: 'Web UI → Synology NAS' }],
  [/QNAP|QTS/, { category: 'nas', os: 'linux', weight: 0.75, evidence: 'Web UI → QNAP NAS' }],
  [/ASUSTOR|\bADM\b/, { category: 'nas', os: 'linux', weight: 0.7, evidence: 'Web UI → ASUSTOR NAS' }],
  [/Plex Media Server|Jellyfin|Emby/i, { category: 'server', weight: 0.5, evidence: 'Web UI → media server' }],
  [/webpages\/login\.html|cgi-bin\/luci/i, { network: true, weight: 0.45, evidence: 'Web UI → router / Wi-Fi admin page' }, 'all'],
  [/OpenWrt|LuCI|DD-WRT|pfSense|OPNsense|RouterOS|MikroTik|FRITZ!Box|ASUSWRT|ASUS Router|NETGEAR|Nighthawk|Orbi|Linksys|Tenda|UniFi|EdgeOS|AirOS|Omada|Archer|TP-?LINK|Deco|eero|Huawei.*(router|HG\d)|ZTE|Sagemcom|Technicolor|Arris/i, { network: true, weight: 0.5, evidence: 'Web UI → router / Wi-Fi admin page' }],
  [/HP HTTP Server|HP-ChaiSOE|Virata-EmWeb|LaserJet|OfficeJet|DeskJet|EPSON|Brother|Canon|Kyocera|Ricoh|Xerox|Lexmark|PrintServer|Printer/i, { category: 'printer', weight: 0.7, evidence: 'Web UI → printer' }],
  [/Shelly|Tasmota|ESPHome|WLED|OctoPrint|Philips hue|deCONZ|zigbee2mqtt|Sonoff|Tuya|solis|inverter|Envoy|SolarEdge|Fronius|myStrom/i, { category: 'smart_home', weight: 0.6, evidence: 'Web UI → smart-home / IoT device' }],
  [/Roku/i, { category: 'media_player', weight: 0.6, evidence: 'Web UI → Roku' }],
  [/Microsoft-IIS|Microsoft-HTTPAPI/i, { os: 'windows', weight: 0.4, evidence: 'Web server Microsoft-HTTPAPI → Windows' }],
  [/lwIP/i, { category: 'smart_home', weight: 0.45, evidence: 'Web server lwIP → embedded IoT device' }],
  [/GoAhead|Boa\/|thttpd|mini_httpd|uhttpd|RomPager|Allegro|micro_httpd/i, { embedded: true, weight: 0.1, evidence: 'Embedded web server' }],
];

/** Hints from an HttpInfo. ctx: { gateway } */
export function httpHints(info, ctx = {}) {
  if (!info) return [];
  const head = [info.server, info.realm, info.title].filter(Boolean).join(' | ');
  const all = `${head} | ${info.body || ''}`;
  const label = info.title || info.realm || info.server;
  const out = [];
  for (const [re, h, scope = 'head'] of SIGNATURES) {
    if (!re.test(scope === 'all' ? all : head)) continue;
    if (out.some((o) => o.evidence.startsWith(h.evidence))) continue;
    const evidence = label ? `${h.evidence} ("${label.slice(0, 40)}")` : h.evidence;
    if (h.network) {
      if (ctx.gateway) out.push({ category: 'router', weight: h.weight, evidence });
      else {
        out.push({ category: 'access_point', weight: h.weight, evidence });
        out.push({ category: 'router', weight: h.weight * 0.6, evidence });
      }
    } else if (h.embedded) {
      out.push({ weight: h.weight, evidence });
    } else {
      const { manufacturer, ...rest } = h;
      out.push({ ...rest, evidence, ...(manufacturer ? { manufacturer } : {}) });
    }
    if (out.length >= 3) break;
  }
  return out;
}
