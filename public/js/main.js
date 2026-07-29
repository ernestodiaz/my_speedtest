import { createChart } from './chart.js';
import { createUi } from './ui.js';
import { runDownload } from './download.js';
import { runPing } from './ping.js';
import { runUpload } from './upload.js';
import { formatMs, jitter, summarize } from './stats.js';

const ui = createUi();
const chart = createChart(ui.nodes.canvas, ui.nodes.tip);

let info = null;
let running = false;

// Phase weights for the progress bar, so it advances at a believable rate
// instead of jumping in thirds.
const WEIGHTS = { ping: 0.12, download: 0.44, upload: 0.44 };

async function loadInfo() {
  const res = await fetch('/info', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Cannot reach server: HTTP ${res.status}`);
  info = await res.json();
  ui.serverLine(info);
  return info;
}

function progressFor(phase, fraction) {
  const before = phase === 'ping' ? 0 : phase === 'download' ? WEIGHTS.ping : WEIGHTS.ping + WEIGHTS.download;
  return before + WEIGHTS[phase] * Math.max(0, Math.min(1, fraction));
}

async function runTest() {
  if (running) return;
  running = true;
  ui.running(true);
  ui.error(null);
  ui.showChart();
  chart.reset();
  refreshTable();

  try {
    if (!info) await loadInfo();
    const t = info.test;

    // ---- latency ----
    ui.phase('Latency');
    ui.progress(0, 'download');
    const pings = await runPing({
      count: t.pingCount,
      warmup: t.pingWarmup,
      onSample: (rtt, i, total) => {
        ui.live(formatMs(rtt), 'ms');
        ui.progress(progressFor('ping', i / total), 'download');
      },
    });
    const latency = summarize(pings);
    const jitterMs = jitter(pings);
    if (!latency) throw new Error('No latency samples were collected.');
    ui.live(formatMs(latency.avg), 'ms');

    // ---- download ----
    ui.phase('Download');
    const download = await runDownload({
      streams: t.parallelStreams,
      durationMs: t.testDurationMs,
      warmupMs: t.warmupMs,
      onSample: ({ mbps, elapsed, durationMs }) => {
        ui.liveSpeed(mbps);
        ui.progress(progressFor('download', elapsed / durationMs), 'download');
        chart.addPoint('download', elapsed / 1000, mbps);
      },
    });
    ui.liveSpeed(download.mbps);

    // ---- upload ----
    ui.phase('Upload');
    // Upload continues the same x axis so both phases read as one timeline.
    const uploadOffset = download.totalMs / 1000 + 1;
    const upload = await runUpload({
      streams: t.parallelStreams,
      durationMs: t.testDurationMs,
      warmupMs: t.warmupMs,
      chunkBytes: t.uploadChunkBytes,
      // Chrome refuses to send a streaming request body over HTTP/1.1, so the
      // transport the server actually negotiated decides whether that path is
      // even worth attempting.
      allowStreaming: Number.parseInt(info.client.httpVersion, 10) >= 2,
      onSample: ({ mbps, elapsed, durationMs }) => {
        ui.liveSpeed(mbps);
        ui.progress(progressFor('upload', elapsed / durationMs), 'upload');
        chart.addPoint('upload', uploadOffset + elapsed / 1000, mbps);
      },
    });

    // ---- results ----
    await loadInfo(); // refresh the httpVersion/worker line from the real test path
    ui.phase('Complete');
    ui.progress(1, 'upload');
    ui.liveSpeed(download.mbps);
    ui.results({ latency, jitterMs, download, upload, info });
    refreshTable();
  } catch (err) {
    ui.phase('Failed');
    ui.live('—', '');
    ui.progress(0, 'download');
    ui.error(err?.message ?? String(err));
  } finally {
    running = false;
    ui.running(false);
  }
}

function refreshTable() {
  if (ui.nodes.tableView.hidden) return;
  ui.nodes.tableView.innerHTML = chart.tableHtml();
}

ui.nodes.tableToggle.addEventListener('click', () => {
  const shown = ui.nodes.tableView.hidden;
  ui.nodes.tableView.hidden = !shown;
  ui.nodes.tableToggle.setAttribute('aria-expanded', String(shown));
  ui.nodes.tableToggle.textContent = shown ? 'Hide table' : 'Table view';
  if (shown) refreshTable();
});

ui.nodes.start.addEventListener('click', runTest);

loadInfo().catch((err) => ui.error(err.message));
