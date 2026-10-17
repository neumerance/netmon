// Static file serving for the packaged executable: the built web app (web/dist) is embedded as Node SEA
// assets by scripts/build-exe.mjs and served from memory, mirroring the express.static setup used when
// running from source (index.html no-cache, other files 1 h, ETag / Last-Modified + 304, HEAD, MIME types).

import crypto from 'node:crypto';
import path from 'node:path';

/**
 * @param {{ manifest: { files: { path: string, key: string, mtimeMs?: number }[] },
 *           getAsset: (key: string) => ArrayBuffer }} assets
 */
export function createEmbeddedStatic(assets) {
  const files = new Map();
  for (const f of assets.manifest?.files || []) {
    const body = Buffer.from(assets.getAsset(f.key));
    const hash = crypto.createHash('sha1').update(body).digest('base64url').slice(0, 27);
    files.set(`/${f.path}`, {
      body,
      ext: path.extname(f.path) || '.bin',
      etag: `"${body.length.toString(16)}-${hash}"`,
      lastModified: new Date(f.mtimeMs || Date.now()).toUTCString(),
      noCache: f.path === 'index.html' || f.path.endsWith('/index.html'),
    });
  }

  const send = (req, res, file) => {
    res.type(file.ext);
    res.setHeader('Cache-Control', file.noCache ? 'no-cache' : 'public, max-age=3600');
    res.setHeader('ETag', file.etag);
    res.setHeader('Last-Modified', file.lastModified);
    if (req.fresh) return res.status(304).end();
    res.setHeader('Content-Length', String(file.body.length));
    return req.method === 'HEAD' ? res.end() : res.end(file.body);
  };

  /** express middleware: serve an embedded file or fall through. */
  const middleware = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p;
    try {
      p = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = files.get(p);
    return file ? send(req, res, file) : next();
  };

  const index = files.get('/index.html') || null;
  return {
    middleware,
    hasIndex: Boolean(index),
    /** Send index.html (SPA fallback). */
    sendIndex: (req, res) => send(req, res, index),
    size: files.size,
  };
}
