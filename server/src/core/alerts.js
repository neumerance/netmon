// Pure alert computation (PLAN §4.5 / §6.2). No I/O, no timers; deterministic for a given input.

const LEVEL_RANK = { critical: 0, warning: 1, info: 2 };

function displayName(d) {
  return d.name || d.hostname || d.model || d.vendor || d.ip || d.mac;
}

function fmtMbps(n) {
  return Number(n).toFixed(1);
}

/**
 * @param {object} input
 * @param {object} input.internet        InternetStatus
 * @param {object} input.speed           speed state (needs `.last`)
 * @param {object[]} input.devices       wire Devices
 * @param {object} input.settings        Settings
 * @param {boolean} input.firstScanDone
 * @param {object[]} [input.previous]    previously computed alerts (to preserve `since`)
 * @param {string|null} [input.lastOnlineAt]  ISO of last successful internet check (for the down message)
 * @param {number} [input.now]
 * @returns {object[]} Alert[] sorted critical → warning → info, then since ascending
 */
export function computeAlerts({ internet, speed, devices = [], settings, firstScanDone, previous = [], lastOnlineAt = null, now = Date.now() }) {
  const prevById = new Map((previous || []).map((a) => [a.id, a]));
  const keepSince = (id, fallback) => prevById.get(id)?.since ?? fallback;
  const nowIso = new Date(now).toISOString();
  const alerts = [];

  const down = internet?.status === 'down';
  if (down) {
    const since = internet.since ?? keepSince('internet_down', nowIso);
    alerts.push({
      id: 'internet_down',
      level: 'critical',
      kind: 'internet_down',
      title: 'Internet is down',
      message: lastOnlineAt
        ? `No internet connectivity — last successful check ${lastOnlineAt}`
        : 'No internet connectivity — no successful check since NetMon started',
      since,
      mac: null,
    });
  }

  const last = speed?.last;
  const threshold = settings?.speedThresholdMbps;
  if (!down && last && typeof last.downloadMbps === 'number' && typeof threshold === 'number'
      && last.downloadMbps < threshold) {
    alerts.push({
      id: 'slow_speed',
      level: 'warning',
      kind: 'slow_speed',
      title: `Internet speed below ${threshold} Mbps`,
      message: `Last test measured ${fmtMbps(last.downloadMbps)} Mbps download (threshold ${threshold} Mbps).`,
      since: keepSince('slow_speed', last.at ?? nowIso),
      mac: null,
    });
  }

  if (firstScanDone) {
    for (const d of devices) {
      if (!d.saved || d.online) continue;
      const id = `device_offline:${d.mac}`;
      alerts.push({
        id,
        level: 'info',
        kind: 'device_offline',
        title: `${displayName(d)} is offline`,
        message: d.lastSeen ? `Last seen ${d.lastSeen}` : 'Not seen since NetMon started',
        since: d.lastSeen ?? keepSince(id, nowIso),
        mac: d.mac,
      });
    }
  }

  alerts.sort((a, b) => (LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
    || String(a.since).localeCompare(String(b.since))
    || a.id.localeCompare(b.id));
  return alerts;
}

/** Stable comparison key: a change in this key means the alert list must be re-broadcast. */
export function alertsKey(alerts) {
  return JSON.stringify((alerts || []).map((a) => [a.id, a.since, a.title, a.message]));
}
