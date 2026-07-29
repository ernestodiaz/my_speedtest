import { config } from '../config.js';
import { chunkAt, payloadInfo } from '../payload.js';
import { NO_STORE_STREAM } from '../headers.js';

// Backpressure normally stops the write loop long before this, but if the
// socket keeps accepting we must still yield so the event loop is not starved.
const MAX_WRITES_PER_TICK = 512;

/**
 * Unbounded download stream.
 *
 * There is deliberately no size parameter. The test is duration-based: the
 * client opens N of these in parallel and aborts them when its measurement
 * window closes. That removes any need for size negotiation or adaptive
 * resizing -- one endpoint, one behavior, from a throttled phone to a 10 GbE
 * LAN.
 *
 * The server-side ceilings below exist only so an abandoned stream cannot run
 * forever; a normal test never reaches them.
 */
export function handleDownload(req, res, ctx) {
  // No body on HEAD -- and critically, no write loop either. Node discards body
  // writes for HEAD responses, so res.write() would never report backpressure
  // and the loop would spin forever.
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', ...NO_STORE_STREAM });
    res.end();
    return;
  }

  const release = ctx.limiter.tryAcquire();
  if (!release) return ctx.busy(res);

  res.socket?.setNoDelay(true);

  // No Content-Length plus Connection: close means Node streams raw bytes with
  // no chunked-transfer framing, and the response simply ends with the socket.
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    Connection: 'close',
    ...NO_STORE_STREAM,
  });

  const startedAt = performance.now();
  let bytes = 0;
  // Start at a random offset in the payload ring so no two responses are
  // byte-identical. Costs one call per stream, and makes "is anything caching
  // this?" an answerable question rather than an article of faith.
  let index = Math.floor(Math.random() * payloadInfo.chunkCount);
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    res.off('drain', pump);
    release();
    res.end();
  }

  function pump() {
    if (done) return;
    let writes = 0;
    for (;;) {
      if (bytes >= config.maxStreamBytes) return finish();
      if (performance.now() - startedAt >= config.maxStreamMs) return finish();
      if (writes >= MAX_WRITES_PER_TICK) return void setImmediate(pump);

      writes += 1;
      const chunk = chunkAt(index++);
      bytes += chunk.length;
      // false means the write buffer is above its high-water mark; stop and
      // wait for 'drain' rather than queueing chunks in memory.
      if (!res.write(chunk)) return;
    }
  }

  res.on('drain', pump);
  res.on('close', finish);
  res.on('error', finish);

  pump();
}
