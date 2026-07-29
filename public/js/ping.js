/**
 * Latency probe.
 *
 * Timed with performance.now(): it is monotonic and sub-millisecond, where
 * Date.now() is neither and can jump backwards mid-test if the clock is
 * adjusted.
 *
 * The first `warmup` probes are thrown away. They pay for the TCP handshake and
 * for the connection not yet being in the OS or browser's hot path, so they
 * measure setup rather than round-trip time.
 */
export async function runPing({ count, warmup, signal, onSample }) {
  const samples = [];
  const total = count + warmup;

  for (let i = 0; i < total; i += 1) {
    if (signal?.aborted) break;
    const started = performance.now();
    const res = await fetch(`/ping?cb=${Math.random().toString(36).slice(2)}`, {
      cache: 'no-store',
      signal,
    });
    // 204 has no body, but the response must still be settled before the round
    // trip counts as complete.
    await res.arrayBuffer();
    const rtt = performance.now() - started;

    if (!res.ok && res.status !== 204) {
      throw new Error(`Ping failed: HTTP ${res.status}`);
    }
    if (i >= warmup) {
      samples.push(rtt);
      onSample?.(rtt, samples.length, count);
    }
  }

  return samples;
}
