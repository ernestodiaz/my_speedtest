const SOURCE_BYTES = 8 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 256 * 1024;
const SAMPLE_INTERVAL_MS = 200;
const CRYPTO_MAX = 65536; // crypto.getRandomValues() rejects larger requests

let sourceBuffer = null;
let postBody = null;

/**
 * One buffer of randomness, generated once.
 *
 * getRandomValues() runs around 1-2 GB/s and caps at 64 KiB per call, so
 * generating fresh randomness for a multi-gigabyte upload would measure the
 * CSPRNG rather than the link. Random (rather than zeroed or text) content
 * still matters: anything compressible would let a proxy or the browser shrink
 * the payload and inflate the result.
 */
function source() {
  if (sourceBuffer) return sourceBuffer;
  const buf = new Uint8Array(SOURCE_BYTES);
  for (let o = 0; o < buf.length; o += CRYPTO_MAX) {
    crypto.getRandomValues(buf.subarray(o, Math.min(o + CRYPTO_MAX, buf.length)));
  }
  sourceBuffer = buf;
  return buf;
}

function bodyOfSize(bytes) {
  if (postBody?.length === bytes) return postBody;
  const src = source();
  const out = new Uint8Array(bytes);
  for (let o = 0; o < bytes; o += src.length) {
    out.set(src.subarray(0, Math.min(src.length, bytes - o)), o);
  }
  postBody = out;
  return out;
}

/**
 * Does this browser implement streaming request bodies at all? The canonical
 * probe: constructing a Request with a ReadableStream body throws where
 * unsupported, and only a supporting implementation reads the `duplex` getter.
 *
 * API support is necessary but NOT sufficient -- see `streamingUsable()`.
 */
const supportsRequestStreams = (() => {
  let duplexAccessed = false;
  let hasContentType = false;
  try {
    const req = new Request('https://example.com', {
      method: 'POST',
      body: new ReadableStream(),
      get duplex() {
        duplexAccessed = true;
        return 'half';
      },
    });
    hasContentType = req.headers.has('Content-Type');
  } catch {
    return false;
  }
  return duplexAccessed && !hasContentType;
})();

function isAbort(err) {
  return err?.name === 'AbortError';
}

/**
 * Set once the streaming transport has been proven not to work on this
 * connection, so we never pay for a second failed attempt.
 */
let streamingDisabled = false;

/**
 * Whether to actually attempt the streaming path.
 *
 * Chrome implements streaming request bodies but refuses to send one over
 * HTTP/1.1 -- the fetch rejects with a bare "Failed to fetch" before a byte
 * leaves the browser. This app is served over plain HTTP *by design* (HTTP/2
 * would multiplex the parallel download streams onto one TCP connection and
 * silently defeat them), so on a normal deployment the streaming path is
 * unusable no matter what the feature probe says.
 *
 * `allowStreaming` therefore carries the negotiated HTTP version from /info.
 * The runtime fallback below is still kept as a backstop, because a proxy can
 * make the version we observed on one request differ from the next.
 */
function streamingUsable(allowStreaming) {
  return supportsRequestStreams && allowStreaming && !streamingDisabled;
}

/** One long-lived POST that streams until the deadline, then closes cleanly. */
async function streamUntil({ deadline, signal, onBytes }) {
  const src = source();
  let offset = 0;

  const body = new ReadableStream({
    pull(controller) {
      if (performance.now() >= deadline || signal.aborted) {
        controller.close();
        return;
      }
      if (offset + STREAM_CHUNK_BYTES > src.length) offset = 0;
      // slice() copies. Enqueued buffers may be transferred by the platform, so
      // handing over a view of the shared source would detach it mid-test.
      controller.enqueue(src.slice(offset, offset + STREAM_CHUNK_BYTES));
      offset += STREAM_CHUNK_BYTES;
      onBytes(STREAM_CHUNK_BYTES);
    },
  });

  const res = await fetch('/upload', {
    method: 'POST',
    body,
    duplex: 'half',
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Fixed-size POST via XHR.
 *
 * XHR rather than fetch here purely for `upload.onprogress`: without streaming
 * request bodies, fetch gives no progress signal at all, so the live graph
 * would sit flat and then jump once per completed POST.
 */
function postOnce({ body, signal, onBytes }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/upload?cb=${Math.random().toString(36).slice(2)}`);
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    let last = 0;
    xhr.upload.onprogress = (e) => {
      onBytes(e.loaded - last);
      last = e.loaded;
    };
    xhr.onload = () => {
      if (xhr.status === 200) resolve(xhr.response);
      else reject(new Error(`Upload failed: HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));

    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', onAbort);

    xhr.send(body);
  });
}

/**
 * Runs one upload phase and returns the server-confirmed result.
 *
 * The reported figure never comes from the client. fetch() resolving, or XHR
 * reporting progress, only means the kernel accepted those bytes into its send
 * buffer -- not that they crossed the wire. The server times what it actually
 * received, and that is what we divide.
 */
async function uploadPhase({ streams, durationMs, chunkBytes, signal, onBytes, useStreaming }) {
  const controller = new AbortController();
  const abortAll = () => controller.abort();
  signal?.addEventListener('abort', abortAll, { once: true });

  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  const stopTimer = setTimeout(abortAll, durationMs + 15_000);
  const results = [];
  let lastCompletion = startedAt;

  const worker = async () => {
    if (useStreaming) {
      const r = await streamUntil({ deadline, signal: controller.signal, onBytes });
      lastCompletion = performance.now();
      results.push(r);
      return;
    }
    const body = bodyOfSize(chunkBytes);
    while (performance.now() < deadline && !controller.signal.aborted) {
      const r = await postOnce({ body, signal: controller.signal, onBytes });
      lastCompletion = performance.now();
      results.push(r);
    }
  };

  const settled = await Promise.allSettled(Array.from({ length: streams }, worker));

  clearTimeout(stopTimer);
  signal?.removeEventListener('abort', abortAll);

  const realFailure = settled.find((r) => r.status === 'rejected' && !isAbort(r.reason));
  if (realFailure && results.length === 0) throw realFailure.reason;

  const bytes = results.reduce((a, r) => a + (r?.timedBytes ?? 0), 0);

  // Two ways to close the window, because the two transports give different
  // evidence:
  //  - streaming: one request per stream spanning the whole phase, so the
  //    server's own first-to-last-byte duration is the window. Durations are
  //    comparable across worker processes even though their clocks are not.
  //  - multi-POST: many short requests per stream, whose server windows
  //    overlap and cannot be summed. Fall back to the client's wall clock,
  //    ending at the last completion. Slightly conservative -- the tail drains
  //    with fewer streams in flight -- which errs toward under-reporting.
  let windowMs;
  if (useStreaming && results.length) {
    windowMs = results.reduce((a, r) => a + (r?.serverMs ?? 0), 0) / results.length;
  } else {
    windowMs = lastCompletion - startedAt;
  }

  return {
    mbps: windowMs > 0 ? (bytes * 8) / (windowMs / 1000) / 1e6 : 0,
    measuredBytes: bytes,
    measuredMs: windowMs,
    requests: results.length,
  };
}

/**
 * Duration-based upload test.
 *
 * Warm-up is a separate discarded phase rather than a trimmed prefix. Upload
 * timing is authoritative only at the server, and the server reports one window
 * per request -- there is no way to ask it to ignore the first two seconds of a
 * request it is already timing. Running and discarding a short phase first
 * sidesteps that entirely, and keep-alive means the measured phase still starts
 * on warm connections.
 */
export async function runUpload({
  streams,
  durationMs,
  warmupMs,
  chunkBytes,
  signal,
  onSample,
  allowStreaming = false,
}) {
  const startedAt = performance.now();
  let totalBytes = 0;
  let lastBytes = 0;
  let lastAt = 0;
  const series = [];
  const onBytes = (n) => {
    totalBytes += n;
  };

  const sampler = setInterval(() => {
    const now = performance.now();
    const elapsed = now - startedAt;
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

  try {
    // The warm-up doubles as the transport probe. Its result is discarded
    // anyway, so discovering here that streaming is unusable costs nothing --
    // whereas discovering it during the measured phase would lose the run.
    if (warmupMs > 0) {
      try {
        await uploadPhase({
          streams,
          durationMs: warmupMs,
          chunkBytes,
          signal,
          onBytes,
          useStreaming: streamingUsable(allowStreaming),
        });
      } catch (err) {
        if (isAbort(err) || !streamingUsable(allowStreaming)) throw err;
        // The streaming path failed for a reason other than us aborting it.
        // Give up on it permanently and warm up again over multi-POST.
        streamingDisabled = true;
        await uploadPhase({
          streams,
          durationMs: warmupMs,
          chunkBytes,
          signal,
          onBytes,
          useStreaming: false,
        });
      }
    }

    const useStreaming = streamingUsable(allowStreaming);
    const measured = await uploadPhase({
      streams,
      durationMs: Math.max(1000, durationMs - warmupMs),
      chunkBytes,
      signal,
      onBytes,
      useStreaming,
    });

    return {
      ...measured,
      streams,
      series,
      method: useStreaming ? 'streaming (duplex)' : 'multi-POST (XHR)',
      warmupDiscarded: warmupMs > 0,
    };
  } finally {
    clearInterval(sampler);
  }
}
