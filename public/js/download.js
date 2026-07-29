const READ_BUFFER_BYTES = 256 * 1024;
const SAMPLE_INTERVAL_MS = 200;

/**
 * Reads one stream to exhaustion, reporting byte counts as they arrive.
 *
 * The BYOB path is what makes multi-gig measurement possible. A default reader
 * hands back a freshly allocated Uint8Array per chunk; at 10 Gbps that is on
 * the order of a gigabyte per second of garbage, and the resulting GC pressure
 * is measured instead of the network. A BYOB reader fills a buffer we own, so
 * the steady state allocates nothing.
 *
 * The subtlety: the ArrayBuffer is *detached* on every read and a new one is
 * handed back attached to `value`. Reusing the original reference throws; we
 * must re-wrap `value.buffer` each time.
 */
async function readStream(res, onBytes) {
  let reader;
  try {
    reader = res.body.getReader({ mode: 'byob' });
  } catch {
    reader = null;
  }

  if (reader) {
    let view = new Uint8Array(new ArrayBuffer(READ_BUFFER_BYTES));
    for (;;) {
      const { done, value } = await reader.read(view);
      if (done) break;
      onBytes(value.byteLength);
      view = new Uint8Array(value.buffer);
    }
    return;
  }

  // Firefox/Safari fallback: correct, just allocation-heavy.
  const plain = res.body.getReader();
  for (;;) {
    const { done, value } = await plain.read();
    if (done) break;
    onBytes(value.byteLength);
  }
}

function isAbort(err) {
  return err?.name === 'AbortError';
}

/**
 * Duration-based download test over N parallel connections.
 *
 * Parallel streams matter because a single TCP connection is limited by its
 * congestion window and by receive-buffer autotuning; on a fast link one
 * connection routinely reports well under the real capacity. Over plain HTTP/1.1
 * these are genuinely separate sockets. (Over HTTP/2 they would multiplex onto
 * one connection and the whole technique would quietly do nothing.)
 *
 * The first `warmupMs` are excluded from the final figure: TCP slow start means
 * early throughput is a ramp, not a rate.
 */
export async function runDownload({ streams, durationMs, warmupMs, signal, onSample }) {
  const controller = new AbortController();
  const abortAll = () => controller.abort();
  signal?.addEventListener('abort', abortAll, { once: true });

  const startedAt = performance.now();
  let totalBytes = 0;
  let warmBytes = null;
  let warmAt = null;
  let lastBytes = 0;
  let lastAt = 0;
  const series = [];

  const sampler = setInterval(() => {
    const now = performance.now();
    const elapsed = now - startedAt;
    if (warmBytes === null && elapsed >= warmupMs) {
      warmBytes = totalBytes;
      warmAt = elapsed;
    }
    // Instantaneous rate over the sampling window, not the running average --
    // a running average hides the slow-start ramp the graph is there to show.
    const windowMs = lastAt === 0 ? elapsed : now - lastAt;
    const windowBytes = totalBytes - lastBytes;
    lastBytes = totalBytes;
    lastAt = now;
    if (windowMs > 0) {
      const mbps = (windowBytes * 8) / (windowMs / 1000) / 1e6;
      series.push({ t: elapsed / 1000, mbps });
      onSample?.({ mbps, elapsed, durationMs });
    }
  }, SAMPLE_INTERVAL_MS);

  const stopTimer = setTimeout(abortAll, durationMs);

  const open = async () => {
    const res = await fetch(`/download?cb=${Math.random().toString(36).slice(2)}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    await readStream(res, (n) => {
      totalBytes += n;
    });
  };

  const settled = await Promise.allSettled(
    Array.from({ length: streams }, () => open()),
  );

  clearInterval(sampler);
  clearTimeout(stopTimer);
  signal?.removeEventListener('abort', abortAll);

  const realFailure = settled.find(
    (r) => r.status === 'rejected' && !isAbort(r.reason),
  );
  if (realFailure && totalBytes === 0) throw realFailure.reason;

  const elapsed = performance.now() - startedAt;
  // If the run was too short to clear warm-up, measure the whole thing rather
  // than reporting nothing.
  const useTrim = warmBytes !== null && elapsed - warmAt > 250;
  const measuredBytes = useTrim ? totalBytes - warmBytes : totalBytes;
  const measuredMs = useTrim ? elapsed - warmAt : elapsed;

  return {
    mbps: measuredMs > 0 ? (measuredBytes * 8) / (measuredMs / 1000) / 1e6 : 0,
    measuredBytes,
    measuredMs,
    totalBytes,
    totalMs: elapsed,
    warmupTrimmed: useTrim,
    streams,
    series,
  };
}
