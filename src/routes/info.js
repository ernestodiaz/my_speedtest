import os from 'node:os';
import { config, clientConfig } from '../config.js';
import { payloadInfo } from '../payload.js';
import { sendJson } from '../headers.js';

function externalAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.internal) continue;
      if (ni.family === 'IPv4' || ni.family === 4) out.push({ name, address: ni.address });
    }
  }
  return out;
}

/**
 * Context for the results panel, and the single source of truth for the test
 * parameters the browser uses -- the client never hardcodes a duration or a
 * stream count, it asks for them here.
 */
export function handleInfo(req, res, ctx) {
  sendJson(res, 200, {
    server: {
      hostname: os.hostname(),
      addresses: externalAddresses(),
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      pid: process.pid,
      workers: config.workers,
      reusePort: config.reusePort,
      cores: os.cpus().length,
      uptimeSec: Math.round(process.uptime()),
    },
    client: {
      address: req.socket.remoteAddress,
      httpVersion: req.httpVersion,
    },
    payload: payloadInfo,
    // Each worker owns its own limiter -- a shared counter would need IPC on
    // the hot path. So these are per-worker figures, and this response comes
    // from whichever worker happened to accept the request: activeStreams is
    // that one worker's count, not a server-wide total.
    limits: {
      maxConcurrentStreamsPerWorker: config.maxConcurrentStreams,
      maxConcurrentStreamsTotal: config.maxConcurrentStreams * config.workers,
      activeStreamsThisWorker: ctx.limiter.active,
      maxStreamMs: config.maxStreamMs,
    },
    test: clientConfig(),
  });
}
