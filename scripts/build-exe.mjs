#!/usr/bin/env node
// Build NetMon as a single executable with Node's Single Executable Application (SEA) feature.
//
//   npm run build:exe                 -> dist-exe/NetMon.exe (Windows) or dist-exe/netmon (macOS / Linux)
//   node scripts/build-exe.mjs [--skip-web] [--rebuild-web] [--no-smoke]
//
// Steps: build web/dist (if missing or older than its sources) -> esbuild the server into one CommonJS file
// (build/netmon.cjs) -> embed web/dist as SEA assets -> `node --experimental-sea-config` -> copy this node
// binary -> remove its signature (codesign on macOS, signtool on Windows when available) -> inject the blob
// with postject -> ad-hoc re-sign on macOS -> smoke test `<exe> --version`.
//
// The executable embeds the Node runtime that runs this script (process.execPath), so build with the Node
// version you want to ship (Node 22 LTS recommended; minimum 20.12 / 21.7 for SEA assets) on the target OS.

import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const OUT_DIR = path.join(ROOT, 'dist-exe');
const WEB = path.join(ROOT, 'web');
const WEB_DIST = path.join(WEB, 'dist');
const SERVER = path.join(ROOT, 'server');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const EXE_NAME = IS_WIN ? 'NetMon.exe' : 'netmon';
const OUT = path.join(OUT_DIR, EXE_NAME);
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const args = new Set(process.argv.slice(2));
const log = (msg) => console.log(`[build-exe] ${msg}`);
function fail(msg) {
  console.error(`[build-exe] ERROR: ${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
  if (r.error) fail(`${cmd} ${cmdArgs.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} exited with ${r.status}`);
  return r;
}

function which(cmd) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean) : null;
}

// ------------------------------------------------------------------ 0. preflight
function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  // SEA assets + sea.isSea(): Node 20.12+ / 21.7+ (and every 22+).
  const ok = major >= 22 || (major === 21 && minor >= 7) || (major === 20 && minor >= 12);
  if (!ok) fail(`Node ${process.versions.node} is too old: SEA assets need Node >= 20.12 (Node 22 LTS recommended).`);
  if (process.config?.variables?.node_shared) {
    fail(`this Node (${process.execPath}) is a shared-library build, which cannot be used for SEA. Use an official build from nodejs.org.`);
  }
}

function checkDeps() {
  for (const dep of ['express', 'multicast-dns']) {
    if (!fs.existsSync(path.join(SERVER, 'node_modules', dep, 'package.json'))) {
      fail(`server dependency "${dep}" is not installed. Run: npm --prefix server ci`);
    }
  }
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'esbuild')) || !fs.existsSync(path.join(ROOT, 'node_modules', 'postject'))) {
    fail('esbuild / postject are not installed. Run: npm ci (in the project root)');
  }
}

// ------------------------------------------------------------------ 1. web app
function newestMtime(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const e of fs.readdirSync(p)) newest = Math.max(newest, newestMtime(path.join(p, e)));
  return newest;
}

function buildWeb() {
  const index = path.join(WEB_DIST, 'index.html');
  if (args.has('--skip-web')) {
    if (!fs.existsSync(index)) fail('--skip-web given but web/dist/index.html does not exist');
    log('web: using existing web/dist (--skip-web)');
    return;
  }
  const builtAt = fs.existsSync(index) ? fs.statSync(index).mtimeMs : 0;
  const sourcesAt = Math.max(...['src', 'public', 'index.html', 'vite.config.js', 'package.json']
    .map((p) => newestMtime(path.join(WEB, p))));
  if (builtAt && builtAt >= sourcesAt && !args.has('--rebuild-web')) {
    log('web: web/dist is up to date');
    return;
  }
  if (!fs.existsSync(path.join(WEB, 'node_modules', 'vite'))) fail('web dependencies are not installed. Run: npm --prefix web ci');
  log(builtAt ? 'web: web/dist is older than its sources, rebuilding' : 'web: building web/dist');
  // Run npm through node + npm-cli.js when we were started by npm (no shell needed for npm.cmd on Windows).
  const npmCli = process.env.npm_execpath;
  if (npmCli && /\.c?js$/.test(npmCli)) run(process.execPath, [npmCli, '--prefix', WEB, 'run', 'build'], { cwd: ROOT });
  else run('npm', ['--prefix', WEB, 'run', 'build'], { cwd: ROOT, shell: IS_WIN });
  if (!fs.existsSync(index)) fail('web build did not produce web/dist/index.html');
}

// ------------------------------------------------------------------ 2. server bundle
async function bundleServer() {
  const esbuild = await import('esbuild');
  const outfile = path.join(BUILD, 'netmon.cjs');
  const result = await esbuild.build({
    entryPoints: [path.join(SERVER, 'src', 'index.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: false,
    minify: false,
    keepNames: true,
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
    // ESM-only constructs in the server sources: import.meta.url becomes the bundle file's URL
    // (process.execPath inside a SEA); __NETMON_BUNDLE__ tells core/paths.js it is running bundled.
    define: { 'import.meta.url': '__netmon_import_meta_url', __NETMON_BUNDLE__: 'true' },
    banner: { js: "const __netmon_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
    loader: { '.node': 'file' }, // never expected; detected and rejected below
  });

  // Inputs: no native addons. Outputs: nothing external except Node built-ins
  // (a SEA's require() can only load built-in modules).
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const native = Object.keys(result.metafile.inputs).filter((f) => f.endsWith('.node'));
  if (native.length) fail(`native addons cannot be bundled into a SEA: ${native.join(', ')}`);
  const external = new Set();
  for (const out of Object.values(result.metafile.outputs)) {
    for (const imp of out.imports || []) if (imp.external && !builtins.has(imp.path)) external.add(imp.path);
  }
  if (external.size) fail(`bundle has unresolved non-builtin imports: ${[...external].join(', ')}`);
  log(`bundle: ${path.relative(ROOT, outfile)} (${(fs.statSync(outfile).size / 1024).toFixed(0)} KiB, `
    + `${Object.keys(result.metafile.inputs).length} modules)`);
  return outfile;
}

// ------------------------------------------------------------------ 3. SEA blob
function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function writeSeaConfig(mainFile) {
  const assets = {};
  const files = [];
  for (const abs of listFiles(WEB_DIST).sort()) {
    const rel = path.relative(WEB_DIST, abs).split(path.sep).join('/');
    const key = `web/${rel}`;
    assets[key] = abs;
    files.push({ path: rel, key, mtimeMs: Math.round(fs.statSync(abs).mtimeMs) });
  }
  const manifestFile = path.join(BUILD, 'web-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ builtAt: new Date().toISOString(), files }, null, 2));
  assets['web-manifest.json'] = manifestFile;

  const blob = path.join(BUILD, 'sea-prep.blob');
  const config = {
    main: mainFile,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  };
  const configFile = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  log(`sea-config: ${files.length} web files embedded`);
  return { configFile, blob };
}

// ------------------------------------------------------------------ 4. executable
function removeSignature(file) {
  if (IS_MAC) {
    run('codesign', ['--remove-signature', file]);
  } else if (IS_WIN) {
    const signtool = which('signtool');
    if (signtool) {
      const r = spawnSync(signtool, ['remove', '/s', file], { stdio: 'inherit' });
      if (r.status !== 0) log('signtool remove failed; continuing (the injected exe will carry an invalid signature)');
    } else {
      log('signtool not found; skipping signature removal (the exe works; sign it afterwards if needed)');
    }
  }
}

async function makeExecutable(blob) {
  const nodeBin = process.execPath;
  const nodeBuf = fs.readFileSync(nodeBin);
  if (!nodeBuf.includes(`${SEA_FUSE}:0`)) {
    fail(`${nodeBin} has no unused SEA fuse (not an official Node build, or already a SEA). Use an official build from nodejs.org.`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    fs.rmSync(OUT, { force: true });
  } catch (err) {
    fail(`cannot replace ${OUT} (is NetMon still running?): ${err.message}`);
  }
  fs.writeFileSync(OUT, nodeBuf);
  if (!IS_WIN) fs.chmodSync(OUT, 0o755);
  removeSignature(OUT);

  const { inject } = (await import('postject')).default;
  await inject(OUT, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: SEA_FUSE,
    ...(IS_MAC ? { machoSegmentName: 'NODE_SEA' } : {}),
  });
  if (IS_MAC) run('codesign', ['--sign', '-', OUT]);
}

function smokeTest() {
  if (args.has('--no-smoke')) return;
  const r = spawnSync(OUT, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0 || !/^\d+\.\d+\.\d+/.test(r.stdout.trim())) {
    fail(`smoke test failed: ${EXE_NAME} --version -> status ${r.status}, stdout "${r.stdout?.trim()}", `
      + `stderr "${r.stderr?.trim()}" ${r.error ? r.error.message : ''}`);
  }
  log(`smoke test: ${EXE_NAME} --version -> ${r.stdout.trim()}`);
}

// ------------------------------------------------------------------ main
checkNode();
checkDeps();
fs.mkdirSync(BUILD, { recursive: true });
buildWeb();
const mainFile = await bundleServer();
const { configFile, blob } = writeSeaConfig(mainFile);
run(process.execPath, ['--experimental-sea-config', configFile], { cwd: ROOT });
await makeExecutable(blob);
smokeTest();
const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
log(`done: ${path.relative(ROOT, OUT)} (${mb} MB, Node ${process.versions.node} ${process.platform}-${process.arch})`);
