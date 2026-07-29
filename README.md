# Network Bandwidth & Latency Tester

A single-page web app that measures latency, jitter, download and upload
throughput between the server hosting it and the requesting browser.

Zero runtime dependencies — the backend is `node:*` builtins, the frontend is
vanilla HTML/CSS/ES modules with a hand-drawn `<canvas>` chart. No build step,
no bundler, no CDN calls (it works fully offline inside a container).

## The dashboard

![The speed test dashboard after a completed run: a 287 Mbps headline reading, a
throughput-over-time chart showing the download phase then the upload phase, and
result tiles for latency, jitter, download and upload](docs/dashboard.png)

A completed run against a 2-worker Linux host over Wi-Fi. Reading it:

- **One timeline, one axis.** Download (blue) runs 0–12s, upload (orange) 13–27s.
  They never share an instant, so the single Mbps scale stays honest — there is
  no second y-axis to invent a correlation.
- **The upload trace is spikier than the download trace**, and that is expected
  rather than noise. The live line is the client's *optimistic* count: XHR
  reports bytes as the kernel accepts them into the send buffer, which arrives in
  bursts. The **492 Mbps tile is server-confirmed** — the server timed what it
  actually received. When the two disagree, the tile is right.
- **Warm-up is already excluded** from both tiles; the first 2s of each phase is
  discarded because TCP slow start makes early throughput a ramp, not a rate.
- **Latency 4.99 ms / jitter 1.76 ms** come from 20 probes with the first 2
  discarded, so no handshake cost is folded in.
- The footer names the server, the worker count and the negotiated HTTP version
  (`HTTP/1.1` here — which is deliberate, see *Scaling and accuracy*).
- **Table view** under the chart exposes every plotted sample as text, so nothing
  in the figure is reachable only by colour or only by hover.

*Measurement detail* expands to the full breakdown: percentiles, standard
deviation, bytes transferred, stream count, the upload transport actually used,
and the server's payload configuration.

## Quick start

```bash
# Local
npm start                       # http://localhost:8080

# Container
docker compose up --build       # http://localhost:8080
```

## Endpoints

| Route | Purpose |
|---|---|
| `GET /ping` | 204, empty body, Nagle disabled. Latency probe. |
| `GET /download` | Streams incompressible random bytes until the client disconnects. **No size parameter** — the test is duration-based. |
| `POST /upload` | Reads and discards the body. Returns `{bytes, timedBytes, serverMs}`. |
| `GET /info` | Server identity, active limits, and the test parameters the browser uses. |
| `GET /health` | Liveness for the container healthcheck. |
| `GET /` | The app. |

## Configuration

All via environment variables; every one has a working default.

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `WORKERS` | `min(cores, 8)` | Raise toward core count on a multi-gig host. |
| `REUSE_PORT` | `true` on Linux | SO_REUSEPORT; see *Scaling* below. |
| `TEST_DURATION_MS` | `12000` | Per phase (download, upload). |
| `WARMUP_MS` | `2000` | Discarded from each throughput phase. |
| `PARALLEL_STREAMS` | `6` | Concurrent connections per phase. |
| `PING_COUNT` / `PING_WARMUP` | `20` / `2` | Probes kept / discarded. |
| `PAYLOAD_BYTES` / `CHUNK_BYTES` | `8 MiB` / `512 KiB` | Server send buffer and write size. |
| `UPLOAD_CHUNK_BYTES` | `32 MiB` | Body size on the non-streaming upload path. |
| `MAX_CONCURRENT_STREAMS` | `64` | **Per worker.** Server-wide ceiling is this × `WORKERS`. |
| `MAX_STREAM_MS` | `60000` | Hard per-stream ceiling. |
| `MAX_STREAM_BYTES` / `MAX_UPLOAD_BYTES` | `128 GiB` / `64 GiB` | Backstops; a normal test never reaches them. |

## Methodology, and why

**Latency** — 20 probes over a warmed keep-alive connection, timed with
`performance.now()` (monotonic and sub-millisecond, unlike `Date.now()`). The
first 2 are discarded: they pay for the TCP handshake, so they measure setup
rather than round trip. Reported jitter is the **mean absolute difference
between consecutive round trips** — RFC 3550 §6.4.1's `D` term, unsmoothed. The
RFC's smoothed estimator (`J += (|D| - J)/16`) is deliberately not used: it needs
on the order of a hundred samples to converge, so over a 20-sample probe it
starts at zero and reports a jitter well below the real one.

**Download** — 6 parallel streams for a fixed duration; the first 2s are trimmed
because TCP slow start makes early throughput a ramp, not a rate. There is no
size parameter and no adaptive sizing: the server streams until the client
aborts, which behaves identically from a throttled phone to a 10 GbE LAN.

The client reads with a **BYOB reader**, handing the same `ArrayBuffer` back on
every read. A default reader allocates a fresh `Uint8Array` per chunk — at
multi-gig that is around a gigabyte per second of garbage, and you end up
measuring GC rather than the network. (Firefox/Safari fall back to the default
reader automatically; it is correct, just allocation-heavy.)

**Upload** — same shape, but the reported number is **server-authoritative**. The
client genuinely cannot measure its own upload: `fetch()` resolving only means
the kernel accepted those bytes into its send buffer, not that they crossed the
wire. The server times first-byte to last-byte and returns the count; the live
graph uses the client's optimistic count because it is smooth, and the final
figure never does.

Warm-up here is a *separate discarded phase* rather than a trimmed prefix — the
server reports one window per request, so there is no way to ask it to ignore the
first two seconds of a request it is already timing. Keep-alive means the
measured phase still starts on warm connections.

Two upload transports:

- **Multi-POST via XHR** — a rolling pool of fixed-size POSTs. **This is the path
  a normal deployment uses.** XHR rather than fetch purely for
  `upload.onprogress`; without it the live graph would sit flat and jump once
  per completed POST. Slightly conservative, because the tail drains with fewer
  streams in flight.
- **Streaming (`duplex: 'half'`)** — one long-lived POST per stream, with real
  backpressure. Chromium only, **and only over HTTP/2**: Chrome implements
  streaming request bodies but refuses to send one over HTTP/1.1, rejecting the
  fetch with a bare `Failed to fetch` before a byte leaves the browser.

Since this app is served over plain HTTP by design, the streaming path is
normally unreachable — it exists for deployments that put HTTP/2 in front. The
client therefore gates it on the HTTP version reported by `/info`, not on feature
detection alone: the API probe returns true in Chrome regardless of transport, so
detection by itself would confidently pick a path that always fails. The
discarded warm-up phase doubles as a live probe, so if the attempt fails anyway
the run falls back to multi-POST without losing the measurement.

**Randomness is generated once** on both ends and retransmitted.
`crypto.getRandomValues` caps at 64 KiB per call and runs at 1–2 GB/s, so
generating fresh randomness per chunk would measure the CSPRNG. Retransmitting is
safe against compression skew: gzip's window is 32 KiB, far smaller than the
buffer — and compression is refused outright anyway. Each `/download` response
starts at a random offset in the payload ring, so no two responses are
byte-identical.

## Scaling and accuracy

**Plain HTTP is deliberate.** HTTPS usually negotiates HTTP/2, and HTTP/2
multiplexes all six "parallel" streams onto a single TCP connection — the
technique silently does nothing. If you put TLS in front of this, pin the test
routes to HTTP/1.1 or the multi-stream benefit disappears without any visible
symptom.

**One process will not saturate 10 Gbps**, and receive is the harder half, since
inbound bytes must be materialized into Buffers before being discarded. So the
server runs multiple workers:

- **Linux/BSD** — each worker binds its own socket with `SO_REUSEPORT`; the
  kernel distributes connections by 4-tuple hash, which spreads evenly even
  though a test only opens a handful of sockets.
- **Elsewhere** — a shared listening handle via `cluster` with `SCHED_NONE`.
  Explicitly *not* the default `SCHED_RR`, under which the primary accepts every
  connection itself and becomes the exact bottleneck the forking was meant to
  avoid.

**Container networking is the usual reason results are low.** Docker's default
bridge NATs every packet through netfilter — it cannot carry multi-gig and the
CPU cost shows up as a slow result. Use `--network host` (already set in
`compose.yaml`).

> **On Docker Desktop for Windows/macOS, multi-gig figures are not achievable**
> regardless of configuration — the container runs inside a Linux VM behind a
> virtual NIC. That is a property of the environment, not something the code can
> fix. Windows is fine for development; validate multi-gig on a Linux host.

Figures are **goodput** — application-layer bytes, excluding TCP/IP and TLS
framing (roughly 3–8% below line rate). No overhead multiplier is applied to
flatter the number. Results reflect the route to *this* host, not your connection
in general.

## Verifying a deployment

```bash
# Latency route: expect 204 + no-store
curl -sI http://localhost:8080/ping

# Compression must NOT be applied even when offered
curl -H 'Accept-Encoding: gzip' -sI http://localhost:8080/download   # no Content-Encoding: gzip

# Raw single-stream download rate
curl -so /dev/null -w '%{speed_download} B/s\n' --max-time 10 http://localhost:8080/download

# Server-side byte counting must be exact
head -c 100000000 /dev/urandom | curl -s -X POST --data-binary @- http://localhost:8080/upload
# -> {"bytes":100000000,...}
```

**Backpressure** — run several rate-limited readers and watch RSS stay flat; if
it climbs, unsent chunks are being buffered in memory:

```bash
for i in 1 2 3 4 5 6; do curl -s --limit-rate 2M --max-time 20 -o /dev/null "http://localhost:8080/download?cb=$i" & done
```

**Accuracy** — cross-check against `iperf3` on the same link, same direction,
same stream count:

```bash
iperf3 -c <host> -P 6 -t 12          # download comparison
iperf3 -c <host> -P 6 -t 12 -R       # upload comparison
```

Browser goodput should land within roughly 5–10% of iperf3's TCP figure. A large
gap means the bottleneck is Node or the browser, not the network.

**Cross-browser** — Chrome exercises the BYOB + streaming-upload paths; Firefox
and Safari exercise both fallbacks. Test at least one of each. Chrome DevTools
network throttling covers the low end and confirms warm-up trimming.

## Known limits

- Packet loss is not measured. TCP hides it; it would need a WebRTC/UDP path.
- Single server, single region — no server selection.
- No result history or persistence.
- `MAX_CONCURRENT_STREAMS` is per worker, so `/info` reports `activeStreams` for
  whichever worker answered, not a server-wide total.
