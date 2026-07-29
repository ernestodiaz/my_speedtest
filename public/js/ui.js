import { formatBytes, formatMs, formatSpeed, speedUnit } from './stats.js';

export function el(id) {
  return document.getElementById(id);
}

export function createUi() {
  const nodes = {
    phase: el('phase'),
    liveValue: el('liveValue'),
    liveUnit: el('liveUnit'),
    progressBar: el('progressBar'),
    progressFill: el('progressFill'),
    start: el('start'),
    error: el('error'),
    chart: el('chart'),
    results: el('results'),
    rLatency: el('rLatency'),
    rJitter: el('rJitter'),
    rDown: el('rDown'),
    rUp: el('rUp'),
    detailBody: el('detailBody'),
    serverInfo: el('serverInfo'),
    tableToggle: el('tableToggle'),
    tableView: el('tableView'),
    canvas: el('canvas'),
    tip: el('tip'),
  };

  return {
    nodes,

    phase(text) {
      nodes.phase.textContent = text;
    },

    live(value, unit) {
      nodes.liveValue.textContent = value;
      nodes.liveUnit.textContent = unit ?? '';
    },

    liveSpeed(mbps) {
      nodes.liveValue.textContent = formatSpeed(mbps);
      nodes.liveUnit.textContent = speedUnit(mbps);
    },

    progress(fraction, phaseKey) {
      const pct = Math.max(0, Math.min(1, fraction)) * 100;
      nodes.progressFill.style.width = `${pct}%`;
      nodes.progressBar.setAttribute('aria-valuenow', pct.toFixed(0));
      if (phaseKey) nodes.progressFill.dataset.phase = phaseKey;
    },

    running(isRunning) {
      nodes.start.disabled = isRunning;
      nodes.start.textContent = isRunning ? 'Testing…' : 'Test again';
    },

    error(message) {
      nodes.error.hidden = !message;
      nodes.error.textContent = message ?? '';
    },

    showChart() {
      nodes.chart.hidden = false;
    },

    results({ latency, jitterMs, download, upload, info }) {
      nodes.results.hidden = false;
      nodes.rLatency.textContent = formatMs(latency.avg);
      nodes.rJitter.textContent = formatMs(jitterMs);
      nodes.rDown.textContent = formatSpeed(download.mbps);
      nodes.rUp.textContent = formatSpeed(upload.mbps);

      const row = (dt, dd) => `<dt>${dt}</dt><dd>${dd}</dd>`;
      const group = (t) => `<div class="details__group">${t}</div>`;
      const gbps = (m) => (m >= 1000 ? ` (${(m / 1000).toFixed(2)} Gbps)` : '');

      nodes.detailBody.innerHTML =
        group('Latency') +
        row('Samples', `${latency.count} (after ${info.test.pingWarmup} discarded)`) +
        row('min / p50 / p95 / max',
          `${formatMs(latency.min)} / ${formatMs(latency.p50)} / ${formatMs(latency.p95)} / ${formatMs(latency.max)} ms`) +
        row('Std deviation', `${formatMs(latency.stddev)} ms`) +
        row('Jitter', `${formatMs(jitterMs)} ms — mean |Δ| between consecutive round trips`) +
        group('Download') +
        row('Rate', `${formatSpeed(download.mbps)} ${speedUnit(download.mbps)}${gbps(download.mbps)}`) +
        row('Parallel streams', String(download.streams)) +
        row('Measured', `${formatBytes(download.measuredBytes)} over ${(download.measuredMs / 1000).toFixed(2)} s`) +
        row('Transferred', `${formatBytes(download.totalBytes)} over ${(download.totalMs / 1000).toFixed(2)} s`) +
        row('Warm-up', download.warmupTrimmed
          ? `first ${info.test.warmupMs} ms trimmed`
          : 'not trimmed (run too short)') +
        group('Upload') +
        row('Rate', `${formatSpeed(upload.mbps)} ${speedUnit(upload.mbps)}${gbps(upload.mbps)}`) +
        row('Parallel streams', String(upload.streams)) +
        row('Transport', upload.method) +
        row('Measured', `${formatBytes(upload.measuredBytes)} over ${(upload.measuredMs / 1000).toFixed(2)} s`) +
        row('Requests', String(upload.requests)) +
        row('Source', 'server-confirmed byte counts') +
        group('Server') +
        row('Host', `${info.server.hostname} (${info.server.addresses.map((a) => a.address).join(', ') || 'n/a'})`) +
        row('Runtime', `Node ${info.server.node} on ${info.server.platform}`) +
        row('Workers', `${info.server.workers} of ${info.server.cores} cores${info.server.reusePort ? ', SO_REUSEPORT' : ''}`) +
        row('HTTP version', info.client.httpVersion) +
        row('Payload buffer', `${formatBytes(info.payload.bytes)} in ${formatBytes(info.payload.chunkBytes)} chunks`);
    },

    serverLine(info) {
      const addr = info.server.addresses.map((a) => a.address).join(', ');
      nodes.serverInfo.textContent =
        `Server ${info.server.hostname}${addr ? ` · ${addr}` : ''} · ` +
        `${info.server.workers} worker${info.server.workers === 1 ? '' : 's'} · ` +
        `you are ${info.client.address} over HTTP/${info.client.httpVersion}`;
    },
  };
}
