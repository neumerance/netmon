// Server-Sent Events hub: one long-lived response per client.
// Frame: `event: <type>\ndata: <json>\n\n`; heartbeat comment `:hb\n\n`.

// A client that stops reading (stalled tab, hostile page) would otherwise make Node buffer every frame
// forever: drop it once this much output is queued. Also cap concurrent streams.
export const MAX_BUFFERED_BYTES = 1024 * 1024;
export const MAX_CLIENTS = 20;

export function createSseHub({ getSnapshot, heartbeatMs = 15000, maxClients = MAX_CLIENTS, maxBufferedBytes = MAX_BUFFERED_BYTES }) {
  const clients = new Set();
  let heartbeat = null;

  function frame(type, data) {
    return `event: ${type}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
  }

  function drop(res) {
    clients.delete(res);
    try { res.destroy(); } catch { /* ignore */ }
    stopHeartbeatIfIdle();
  }

  function write(res, chunk) {
    if (res.destroyed || res.writableEnded) { clients.delete(res); return; }
    if ((res.writableLength || 0) > maxBufferedBytes) {
      console.warn('[sse] dropping a client that stopped reading');
      drop(res);
      return;
    }
    try {
      res.write(chunk);
    } catch (err) {
      drop(res);
    }
  }

  function ensureHeartbeat() {
    if (heartbeat || !clients.size) return;
    heartbeat = setInterval(() => {
      for (const res of clients) write(res, ':hb\n\n');
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  function stopHeartbeatIfIdle() {
    if (heartbeat && !clients.size) { clearInterval(heartbeat); heartbeat = null; }
  }

  function handler(req, res) {
    if (clients.size >= maxClients) {
      res.status?.(503);
      res.setHeader('Retry-After', '10');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'too_many_clients', message: 'Too many open NetMon tabs' }));
      return;
    }
    res.status?.(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    req.socket?.setKeepAlive?.(true);
    req.socket?.setNoDelay?.(true);
    req.socket?.setTimeout?.(0);

    write(res, 'retry: 2000\n\n');
    let snapshot;
    try {
      snapshot = getSnapshot();
    } catch (err) {
      console.warn(`[sse] snapshot failed: ${err.message}`);
      snapshot = null;
    }
    write(res, frame('snapshot', snapshot));
    clients.add(res);
    ensureHeartbeat();

    const cleanup = () => { clients.delete(res); stopHeartbeatIfIdle(); };
    req.on('close', cleanup);
    res.on('error', cleanup);
  }

  function broadcast(type, data) {
    if (!clients.size) return;
    const chunk = frame(type, data);
    for (const res of clients) write(res, chunk);
  }

  function closeAll() {
    for (const res of clients) { try { res.end(); } catch { /* ignore */ } }
    clients.clear();
    stopHeartbeatIfIdle();
  }

  return { handler, broadcast, clientCount: () => clients.size, closeAll };
}
