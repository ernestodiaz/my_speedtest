import { config } from '../config.js';
import { sendJson } from '../headers.js';

/**
 * Upload sink. Counts bytes, times them, discards them. Nothing is buffered
 * beyond the current chunk and nothing ever touches disk.
 *
 * This endpoint is the *authoritative* source for the upload figure. The
 * client cannot measure its own upload accurately: fetch() resolving only
 * means the kernel accepted the bytes into its send buffer, not that they
 * crossed the wire. So the server reports what it actually received and when.
 *
 * The first chunk anchors the timing window rather than being measured inside
 * it -- we know when it arrived but not how long it was in flight, so counting
 * its bytes against a window that starts at its arrival would inflate the
 * result. `timedBytes` is therefore the byte count the reported `serverMs`
 * genuinely covers.
 */
export function handleUpload(req, res, ctx) {
  const release = ctx.limiter.tryAcquire();
  if (!release) return ctx.busy(res);

  req.socket?.setNoDelay(true);

  let bytes = 0;
  let firstChunkBytes = 0;
  let firstAt = 0;
  let lastAt = 0;
  let settled = false;

  const guard = setTimeout(() => {
    req.destroy();
  }, config.maxStreamMs);

  function cleanup() {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    release();
  }

  req.on('data', (chunk) => {
    const now = performance.now();
    if (firstAt === 0) {
      firstAt = now;
      firstChunkBytes = chunk.length;
    }
    lastAt = now;
    bytes += chunk.length;
    if (bytes > config.maxUploadBytes) req.destroy();
  });

  req.on('end', () => {
    cleanup();
    const serverMs = lastAt > firstAt ? lastAt - firstAt : 0;
    sendJson(res, 200, {
      bytes,
      timedBytes: Math.max(0, bytes - firstChunkBytes),
      serverMs: Number(serverMs.toFixed(3)),
    });
  });

  req.on('error', cleanup);
  req.on('aborted', cleanup);
  res.on('close', cleanup);
}
