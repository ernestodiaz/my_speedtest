// Caching anywhere in the path invalidates every measurement, so every route
// that participates in a test says so as loudly as HTTP allows.
export const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

// Payload routes additionally refuse content-encoding and proxy buffering.
// Compressing the stream would measure the compressor, not the link; buffering
// it in a reverse proxy would flatten the live throughput samples.
export const NO_STORE_STREAM = {
  ...NO_STORE,
  'Content-Encoding': 'identity',
  'X-Accel-Buffering': 'no',
};

export const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  ...NO_STORE,
};

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendText(res, status, text, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...NO_STORE,
    ...extra,
  });
  res.end(text);
}
