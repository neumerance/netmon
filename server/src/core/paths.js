// Runtime paths + configuration for the two ways NetMon runs:
//
//  - From source (`node server/src/index.js`: npm start, npm run dev, e2e): the web app is served from
//    <repo>/web/dist on disk and data lives in server/data. Behaviour is exactly as before packaging existed.
//  - Packaged as a Node Single Executable Application (scripts/build-exe.mjs -> NetMon.exe / netmon): the
//    web app is embedded in the executable as SEA assets ("web/<path>" + "web-manifest.json") and data lives
//    in %ProgramData%\NetMon on Windows, ~/.netmon elsewhere.
//
// NETMON_DATA_DIR always wins for the data directory. Optional netmon.json config files (packaged mode, or any
// mode via NETMON_CONFIG=<file>) supply defaults for the env vars below; a real env var always wins.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// In the esbuild bundle (scripts/build-exe.mjs) `import.meta.url` is defined as the bundle file's URL
// (process.execPath when running as a SEA) and __NETMON_BUNDLE__ as true.
// eslint-disable-next-line no-undef
const BUNDLED = typeof __NETMON_BUNDLE__ !== 'undefined' && __NETMON_BUNDLE__ === true;
const nodeRequire = createRequire(import.meta.url);

function loadSea() {
  try {
    const sea = nodeRequire('node:sea');
    return sea.isSea() ? sea : null;
  } catch {
    return null; // Node < 20.12 has no node:sea: certainly not packaged
  }
}

const SEA = loadSea();

/** True when running as the packaged single executable. */
export const IS_PACKAGED = Boolean(SEA);

// Repo root: server/src/core/paths.js -> ../../..; the bundle lives in <repo>/build/netmon.cjs -> ..
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = BUNDLED ? path.resolve(moduleDir, '..') : path.resolve(moduleDir, '..', '..', '..');
const SERVER_ROOT = path.join(REPO_ROOT, 'server');

/** Directory containing the executable (packaged) — where an optional netmon.json may sit. */
export const EXE_DIR = path.dirname(process.execPath);

function defaultPackagedDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.ProgramData || process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
    return path.join(base, 'NetMon');
  }
  return path.join(os.homedir(), '.netmon');
}

// netmon.json key -> env var it provides a default for.
const CONFIG_KEYS = {
  port: 'PORT',
  host: 'HOST',
  dataDir: 'NETMON_DATA_DIR',
  token: 'NETMON_TOKEN',
  allowLan: 'NETMON_ALLOW_LAN',
  allowedHosts: 'NETMON_ALLOWED_HOSTS',
  snmpCommunity: 'NETMON_SNMP_COMMUNITY',
};

function readConfigFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    console.warn(`[netmon] cannot read config ${file}: ${err?.message || err}`);
    return null;
  }
  try {
    const cfg = JSON.parse(text.replace(/^\uFEFF/, '')); // Notepad may write a BOM
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('top level must be an object');
    return cfg;
  } catch (err) {
    console.warn(`[netmon] ignoring invalid config ${file}: ${err?.message || err}`);
    return null;
  }
}

/** Map a config object to env-style string values (unknown keys ignored). */
function configToEnv(cfg) {
  const out = {};
  for (const [key, envName] of Object.entries(CONFIG_KEYS)) {
    const v = cfg[key];
    if (v === undefined || v === null || v === '') continue;
    if (key === 'allowLan') out[envName] = v === true || v === 1 || v === '1' || v === 'true' ? '1' : '';
    else if (key === 'allowedHosts' && Array.isArray(v)) out[envName] = v.map(String).join(',');
    else out[envName] = String(v);
  }
  return out;
}

/**
 * Resolve where data and the web app live and the effective configuration.
 * @returns {{ packaged: boolean, env: Record<string,string|undefined>, dataDir: string, webDist: string|null,
 *   seaAssets: { manifest: object, getAsset: (key: string) => ArrayBuffer }|null, configFiles: string[] }}
 */
export function resolveRuntime() {
  const configFiles = [];
  const fromFiles = {};
  const apply = (file, { allowDataDir }) => {
    const cfg = readConfigFile(file);
    if (!cfg) return;
    const vals = configToEnv(cfg);
    // A config file inside the data dir cannot move the data dir.
    if (!allowDataDir) delete vals.NETMON_DATA_DIR;
    Object.assign(fromFiles, vals);
    configFiles.push(file);
  };

  if (process.env.NETMON_CONFIG) {
    apply(path.resolve(process.env.NETMON_CONFIG), { allowDataDir: true });
  } else if (IS_PACKAGED) {
    apply(path.join(EXE_DIR, 'netmon.json'), { allowDataDir: true });
  }

  const dataDirSetting = process.env.NETMON_DATA_DIR || fromFiles.NETMON_DATA_DIR;
  const dataDir = path.resolve(dataDirSetting || (IS_PACKAGED ? defaultPackagedDataDir() : path.join(SERVER_ROOT, 'data')));

  if (IS_PACKAGED && !process.env.NETMON_CONFIG) {
    apply(path.join(dataDir, 'netmon.json'), { allowDataDir: false }); // overrides the one next to the exe
  }

  // Real environment variables always win over config files.
  const env = { ...fromFiles };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.NETMON_DATA_DIR = dataDir;

  let seaAssets = null;
  if (SEA) {
    try {
      const manifest = JSON.parse(Buffer.from(SEA.getAsset('web-manifest.json')).toString('utf8'));
      seaAssets = { manifest, getAsset: (key) => SEA.getAsset(key) };
    } catch (err) {
      console.warn(`[netmon] embedded web app missing from this executable: ${err?.message || err}`);
    }
  }

  return {
    packaged: IS_PACKAGED,
    env,
    dataDir,
    webDist: IS_PACKAGED ? null : path.join(REPO_ROOT, 'web', 'dist'),
    seaAssets,
    configFiles,
  };
}
