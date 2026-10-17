// Server-side settings: defaults and strict validation of partial patches.

export const DEFAULT_SETTINGS = Object.freeze({
  speedThresholdMbps: 200,
  speedTestIntervalMin: 15,
  soundAlerts: true,
  activeFingerprinting: true,
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const VALIDATORS = {
  speedThresholdMbps(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'Must be a number';
    if (v < 1 || v > 10000) return 'Must be between 1 and 10000 Mbps';
    return null;
  },
  speedTestIntervalMin(v) {
    if (typeof v !== 'number' || !Number.isInteger(v)) return 'Must be a whole number of minutes';
    if (v !== 0 && (v < 5 || v > 1440)) return 'Must be 0 (off) or between 5 and 1440 minutes';
    return null;
  },
  soundAlerts(v) {
    return typeof v === 'boolean' ? null : 'Must be true or false';
  },
  activeFingerprinting(v) {
    return typeof v === 'boolean' ? null : 'Must be true or false';
  },
};

/**
 * Validate a partial settings patch.
 * @returns {{ ok: true, value: object } | { ok: false, errors: Record<string,string> }}
 */
export function validateSettings(patch) {
  if (!isPlainObject(patch)) return { ok: false, errors: { _: 'Body must be a JSON object' } };
  const errors = {};
  const value = {};
  for (const [key, v] of Object.entries(patch)) {
    const check = VALIDATORS[key];
    if (!check) {
      errors[key] = 'Unknown setting';
      continue;
    }
    const err = check(v);
    if (err) errors[key] = err;
    else value[key] = v;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/** Coerce arbitrary (e.g. loaded-from-disk) settings into a full valid Settings object. */
export function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!isPlainObject(raw)) return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in raw && VALIDATORS[key](raw[key]) === null) out[key] = raw[key];
  }
  return out;
}
