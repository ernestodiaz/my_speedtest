const PAD = { top: 10, right: 12, bottom: 24, left: 48 };
const SERIES = [
  { key: 'download', label: 'Download', token: '--series-dl' },
  { key: 'upload', label: 'Upload', token: '--series-ul' },
];

function niceMax(value) {
  if (!(value > 0)) return 10;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= m * base) return m * base;
  }
  return 10 * base;
}

function fmtTick(v, max) {
  if (max >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1);
  if (max >= 100) return v.toFixed(0);
  if (max >= 10) return v.toFixed(v % 1 === 0 ? 0 : 1);
  return v.toFixed(1);
}

export function createChart(canvas, tipEl) {
  const ctx = canvas.getContext('2d');
  const data = { download: [], upload: [] };
  let hover = null;
  let box = { w: 0, h: 0 };

  const css = (token) =>
    getComputedStyle(canvas).getPropertyValue(token).trim() || '#888';

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    box = { w: rect.width, h: rect.height };
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function bounds() {
    let tMax = 0;
    let vMax = 0;
    for (const s of SERIES) {
      for (const p of data[s.key]) {
        if (p.t > tMax) tMax = p.t;
        if (p.mbps > vMax) vMax = p.mbps;
      }
    }
    return { tMax: Math.max(tMax, 1), vMax: niceMax(vMax * 1.1) };
  }

  function plotRect() {
    return {
      x: PAD.left,
      y: PAD.top,
      w: Math.max(1, box.w - PAD.left - PAD.right),
      h: Math.max(1, box.h - PAD.top - PAD.bottom),
    };
  }

  function scales() {
    const r = plotRect();
    const { tMax, vMax } = bounds();
    return {
      r,
      tMax,
      vMax,
      x: (t) => r.x + (t / tMax) * r.w,
      y: (v) => r.y + r.h - (v / vMax) * r.h,
    };
  }

  function render() {
    if (!box.w) return;
    ctx.clearRect(0, 0, box.w, box.h);
    const { r, tMax, vMax, x, y } = scales();

    const muted = css('--text-muted');
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';

    // Horizontal gridlines: solid hairlines, one shade off the surface.
    ctx.lineWidth = 1;
    ctx.strokeStyle = css('--gridline');
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    const TICKS = 4;
    for (let i = 0; i <= TICKS; i += 1) {
      const v = (vMax / TICKS) * i;
      const py = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(r.x, py);
      ctx.lineTo(r.x + r.w, py);
      ctx.stroke();
      ctx.fillText(fmtTick(v, vMax), r.x - 8, py);
    }

    ctx.fillText(vMax >= 1000 ? 'Gbps' : 'Mbps', r.x - 8, r.y - 2);

    // Baseline
    ctx.strokeStyle = css('--baseline');
    ctx.beginPath();
    ctx.moveTo(r.x, Math.round(y(0)) + 0.5);
    ctx.lineTo(r.x + r.w, Math.round(y(0)) + 0.5);
    ctx.stroke();

    // x ticks
    ctx.textAlign = 'center';
    ctx.fillStyle = muted;
    const step = tMax <= 12 ? 2 : tMax <= 30 ? 5 : 10;
    for (let t = 0; t <= tMax + 0.001; t += step) {
      ctx.fillText(`${t.toFixed(0)}s`, x(t), r.y + r.h + 12);
    }

    // Series
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of SERIES) {
      const pts = data[s.key];
      if (!pts.length) continue;
      ctx.strokeStyle = css(s.token);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const px = x(p.t);
        const py = y(p.mbps);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    if (hover) drawHover(x, y, r);
  }

  function drawHover(x, y, r) {
    const px = x(hover.t);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = css('--baseline');
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, r.y);
    ctx.lineTo(Math.round(px) + 0.5, r.y + r.h);
    ctx.stroke();

    for (const hit of hover.hits) {
      const s = SERIES.find((v) => v.key === hit.key);
      // 2px surface ring so the marker stays legible where it overlaps a line.
      ctx.beginPath();
      ctx.arc(x(hit.point.t), y(hit.point.mbps), 5, 0, Math.PI * 2);
      ctx.fillStyle = css('--surface-1');
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x(hit.point.t), y(hit.point.mbps), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = css(s.token);
      ctx.fill();
    }
    ctx.restore();
  }

  function nearest(t) {
    const hits = [];
    for (const s of SERIES) {
      const pts = data[s.key];
      if (!pts.length) continue;
      let best = pts[0];
      let bestD = Math.abs(best.t - t);
      for (const p of pts) {
        const d = Math.abs(p.t - t);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      // Only report a series whose samples actually cover this instant; the two
      // phases run at different times, so otherwise upload would show a value
      // during the download phase.
      if (bestD <= 0.6) hits.push({ key: s.key, point: best });
    }
    return hits;
  }

  function showTip(clientX) {
    const { r, tMax } = scales();
    const rect = canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    if (localX < r.x || localX > r.x + r.w) return hideTip();

    const t = ((localX - r.x) / r.w) * tMax;
    const hits = nearest(t);
    if (!hits.length) return hideTip();

    hover = { t: hits[0].point.t, hits };
    render();

    tipEl.innerHTML =
      `<div class="tip__t">${hits[0].point.t.toFixed(1)}s</div>` +
      hits
        .map((h) => {
          const s = SERIES.find((v) => v.key === h.key);
          return (
            `<div class="tip__row"><i class="key__swatch key__swatch--${h.key === 'download' ? 'dl' : 'ul'}"></i>` +
            `${s.label} <b>${h.point.mbps.toFixed(h.point.mbps >= 100 ? 0 : 1)}</b> Mbps</div>`
          );
        })
        .join('');
    tipEl.hidden = false;
    const { x, y } = scales();
    tipEl.style.left = `${x(hover.t)}px`;
    tipEl.style.top = `${y(hits[0].point.mbps) - 10}px`;
  }

  function hideTip() {
    if (!hover && tipEl.hidden) return;
    hover = null;
    tipEl.hidden = true;
    render();
  }

  // Pointer events cover mouse, pen and touch with one path.
  canvas.addEventListener('pointermove', (e) => showTip(e.clientX));
  canvas.addEventListener('pointerleave', hideTip);
  canvas.addEventListener('pointercancel', hideTip);

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  return {
    reset() {
      data.download = [];
      data.upload = [];
      hover = null;
      tipEl.hidden = true;
      render();
    },
    addPoint(key, t, mbps) {
      if (!Number.isFinite(mbps)) return;
      data[key].push({ t, mbps });
      render();
    },
    hasData() {
      return data.download.length > 0 || data.upload.length > 0;
    },
    /** The WCAG-clean twin of the plot: every plotted value, readable as text. */
    tableHtml() {
      const rows = [];
      for (const s of SERIES) {
        for (const p of data[s.key]) rows.push({ label: s.label, ...p });
      }
      rows.sort((a, b) => a.t - b.t);
      if (!rows.length) return '<p class="foot">No samples yet.</p>';
      return (
        '<table><thead><tr><th>Phase</th><th>Time (s)</th><th>Mbps</th></tr></thead><tbody>' +
        rows
          .map(
            (r) =>
              `<tr><td>${r.label}</td><td>${r.t.toFixed(1)}</td><td>${r.mbps.toFixed(
                r.mbps >= 100 ? 0 : 2,
              )}</td></tr>`,
          )
          .join('') +
        '</tbody></table>'
      );
    },
  };
}
