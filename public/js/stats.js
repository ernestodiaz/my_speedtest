export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

export function summarize(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const avg = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, v) => a + (v - avg) ** 2, 0) / n;
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    avg,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    stddev: Math.sqrt(variance),
  };
}

/**
 * Jitter as the mean absolute difference between consecutive round trips --
 * RFC 3550 §6.4.1's D term, unsmoothed.
 *
 * The RFC's smoothed estimator (J += (|D| - J)/16) is deliberately not used
 * here: it needs on the order of a hundred samples to converge, so over a
 * ~20-sample probe it starts at zero and reports a jitter far below the real
 * one. The unsmoothed mean is unbiased at this sample count.
 */
export function jitter(samples) {
  if (samples.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    total += Math.abs(samples[i] - samples[i - 1]);
  }
  return total / (samples.length - 1);
}

export function toMbps(bytes, ms) {
  if (!(ms > 0)) return 0;
  return (bytes * 8) / (ms / 1000) / 1e6;
}

export function formatSpeed(mbps) {
  if (!Number.isFinite(mbps)) return '—';
  if (mbps >= 1000) return (mbps / 1000).toFixed(2);
  if (mbps >= 100) return mbps.toFixed(0);
  if (mbps >= 10) return mbps.toFixed(1);
  return mbps.toFixed(2);
}

export function speedUnit(mbps) {
  return mbps >= 1000 ? 'Gbps' : 'Mbps';
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 100 ? ms.toFixed(0) : ms.toFixed(ms >= 10 ? 1 : 2);
}

export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 2)} ${units[i]}`;
}
