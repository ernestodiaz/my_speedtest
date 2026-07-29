import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_STORE, sendText } from '../headers.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

export function handleStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return sendText(res, 400, 'Bad request\n');
  }

  const target = path.resolve(ROOT, `.${decoded === '/' ? '/index.html' : decoded}`);
  // Containment check: resolve() has already collapsed any ../ segments, so a
  // traversal attempt shows up here as a path outside ROOT.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return sendText(res, 403, 'Forbidden\n');
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, 'Not found\n');

    const type = TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      // The app is served no-store too: a stale cached client is worse than a
      // marginally slower page load, and page load is not what we measure.
      ...NO_STORE,
    });

    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(target);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}
