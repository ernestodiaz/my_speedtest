# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A browser-based network speed test: latency/jitter, download and upload
throughput between this server and the requesting browser. Single page, one
button. Designed to stay accurate up to 2.5–10 Gbps, which drives most of the
non-obvious decisions below.

## Commands

```bash
npm start                  # run on :8080
npm run dev                # run with --watch
docker compose up --build  # containerized (host networking)
```

There is no test suite, no linter, and no build step. Verification is empirical —
see *Verifying a deployment* in `README.md` for the curl suite, the backpressure
check, and the iperf3 cross-check.

## Hard constraint: zero dependencies

`package.json` has no `dependencies` field and must not gain one. Backend uses
`node:*` builtins only; frontend is vanilla ES modules served straight from
`public/`. No bundler, no framework, no CDN references — the container has no
network egress and a framework bundle would itself distort perceived load time.
If something seems to need a library, hand-roll it (the chart in
`public/js/chart.js` is why that file exists).

## Layout

```
src/
  server.js         entry: primary/worker split, router, graceful shutdown
  config.js         ALL env parsing + defaults; single source of truth
  payload.js        the one random buffer, pre-sliced into chunk views
  limiter.js        per-worker concurrent-stream cap
  headers.js        no-store / no-compression header sets + JSON helpers
  routes/           ping, download, upload, info, static
public/
  js/main.js        phase orchestration (ping -> download -> upload)
  js/{ping,download,upload}.js   one measurement phase each
  js/stats.js       percentiles, jitter, formatting
  js/chart.js       canvas chart + hover tooltip + table view
  js/ui.js          all DOM writes
```

## Invariants — breaking these silently corrupts measurements

**No caching, no compression, ever.** Every test route sends `no-store` plus
`Content-Encoding: identity` and `X-Accel-Buffering: no` (`src/headers.js`).
There is no middleware layer, which is what keeps compression from sneaking in.
A caching proxy in front of `/download` invalidates every result.

**Randomness is generated once, never per chunk.** `src/payload.js` fills one
8 MiB buffer at startup; the client does the same in `public/js/upload.js`.
`crypto.getRandomValues` caps at 64 KiB/call and runs at 1–2 GB/s — per-chunk
generation measures the CSPRNG, not the link.

**`res.write()`'s return value must be honored.** `routes/download.js` stops on
`false` and resumes on `drain`. Ignoring it buffers unsent chunks in memory and
turns a 12s test into an OOM. There is also a `MAX_WRITES_PER_TICK` yield so a
fast client cannot starve the event loop.

**HEAD on `/download` must not enter the write loop.** Node discards body writes
for HEAD, so `res.write()` never reports backpressure and the loop spins
forever. Handled explicitly at the top of the route.

**Upload figures come from the server, never the client.** `fetch()` resolving
means the kernel took the bytes, not that they crossed the wire. `/upload`
returns `{bytes, timedBytes, serverMs}`; `timedBytes` excludes the first chunk
because that chunk's flight time is unknown and would inflate the rate. The
client's own count feeds the live graph only.

**Download client uses a BYOB reader.** `public/js/download.js` reuses one
`ArrayBuffer`. Note the trap: the buffer is *detached* on every read, so the code
must re-wrap `value.buffer` rather than the original reference. A default reader
allocates per chunk and at multi-gig you measure GC. Firefox/Safari fall back
automatically.

**Duration-based, never size-based.** `/download` takes no size parameter and
streams until the client aborts. Do not reintroduce `?bytes=N` or adaptive
sizing — the abort-on-duration design replaces both.

**Plain HTTP is load-bearing.** Over HTTP/2 the six parallel streams multiplex
onto one TCP connection and the multi-stream technique silently stops working.
If TLS is ever added, pin the test routes to HTTP/1.1.

**Limits are per worker.** Each worker has its own `limiter`; a shared counter
would need IPC on the hot path. `/info` reports the answering worker's count, and
the server-wide cap is `MAX_CONCURRENT_STREAMS × WORKERS`.

## Worker model

`src/server.js` picks one of two paths, both avoiding a single-threaded accept
bottleneck:

- **Linux/BSD** (`REUSE_PORT`, default on): `child_process.fork`, each child
  binding its own socket with `SO_REUSEPORT`. Kernel spreads connections by
  4-tuple hash. Falls back automatically if the kernel rejects the flag.
- **Elsewhere**: `cluster` with `schedulingPolicy = SCHED_NONE`. Deliberately not
  the default `SCHED_RR`, where the primary accepts everything itself.

## Charts

`public/js/chart.js` follows the `dataviz` skill's rules: two categorical slots
(blue `--series-dl`, orange `--series-ul`, validated in both light and dark),
2px lines, solid hairline gridlines, a legend plus a table-view twin, one y axis.
Never add a second y scale. Palette tokens live at the top of `public/style.css`
with dark values declared under both `prefers-color-scheme` and `[data-theme]`.

## Adding config

Add it to `src/config.js` only — nothing else reads `process.env`. If the browser
needs it, add it to `clientConfig()`; the frontend takes all test parameters from
`/info` and hardcodes none.
