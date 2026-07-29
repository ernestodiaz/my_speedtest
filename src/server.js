import http from 'node:http';
import cluster from 'node:cluster';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { createLimiter } from './limiter.js';
import { NO_STORE, sendJson, sendText } from './headers.js';
import { handlePing } from './routes/ping.js';
import { handleDownload } from './routes/download.js';
import { handleUpload } from './routes/upload.js';
import { handleInfo } from './routes/info.js';
import { handleStatic } from './routes/static.js';

const SELF = fileURLToPath(import.meta.url);
const IS_FORKED_CHILD = process.env.SPEEDTEST_CHILD === '1';
const WORKER_ID = process.env.SPEEDTEST_WORKER_ID ?? '0';

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function createApp() {
  const limiter = createLimiter(config.maxConcurrentStreams);

  const ctx = {
    limiter,
    busy(res) {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': '5',
        ...NO_STORE,
      });
      res.end('Too many concurrent test streams\n');
    },
  };

  function onRequest(req, res) {
    const q = req.url.indexOf('?');
    const pathname = q === -1 ? req.url : req.url.slice(0, q);

    switch (pathname) {
      case '/ping':
        return handlePing(req, res);

      case '/download':
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendText(res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
        }
        return handleDownload(req, res, ctx);

      case '/upload':
        if (req.method !== 'POST' && req.method !== 'PUT') {
          return sendText(res, 405, 'Method not allowed\n', { Allow: 'POST, PUT' });
        }
        return handleUpload(req, res, ctx);

      case '/info':
        return handleInfo(req, res, ctx);

      case '/health':
        return sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          activeStreams: limiter.active,
          uptimeSec: Math.round(process.uptime()),
        });

      default:
        return handleStatic(req, res, pathname);
    }
  }

  const server = http.createServer(onRequest);

  // A test stream is a long-lived request that sends no headers for its whole
  // life. The defaults would cut it off partway through.
  server.requestTimeout = Math.max(config.maxStreamMs * 2, 120_000);
  server.headersTimeout = 70_000;
  server.keepAliveTimeout = 65_000;
  server.maxRequestsPerSocket = 0;

  return server;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

function startWorker() {
  const server = createApp();

  // SO_REUSEPORT is only meaningful for independently forked children, each of
  // which binds its own listening socket. Under cluster the primary owns the
  // handle and shares it, so the flag is not ours to set.
  const wantReusePort = IS_FORKED_CHILD && config.reusePort;

  const listen = (reusePort) => {
    server.listen({ port: config.port, host: config.host, reusePort });
  };

  server.on('error', function onError(err) {
    if (reusePortRetryable(err) && wantReusePort) {
      // Kernel does not support it (or Node was built without it). Losing the
      // even connection spread is survivable; failing to boot is not.
      console.warn(`[worker ${WORKER_ID}] SO_REUSEPORT unavailable (${err.code}); retrying without it`);
      server.removeListener('error', onError);
      server.on('error', fatal);
      listen(false);
      return;
    }
    fatal(err);
  });

  server.on('listening', () => {
    const { port } = server.address();
    console.log(
      `[worker ${WORKER_ID}] pid ${process.pid} listening on http://${config.host}:${port}` +
        (wantReusePort ? ' (SO_REUSEPORT)' : ''),
    );
  });

  listen(wantReusePort);
  installWorkerShutdown(server);
}

function reusePortRetryable(err) {
  return (
    err.code === 'ENOTSUP' ||
    err.code === 'EINVAL' ||
    err.code === 'EOPNOTSUPP' ||
    err.code === 'ERR_INVALID_ARG_TYPE' ||
    err.code === 'ERR_INVALID_ARG_VALUE'
  );
}

function fatal(err) {
  console.error(`[worker ${WORKER_ID}] ${err.stack ?? err}`);
  process.exit(1);
}

function installWorkerShutdown(server) {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    // In-flight download streams never end on their own -- they run until the
    // client aborts. Cut them so the process can actually exit.
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ---------------------------------------------------------------------------
// Primary
// ---------------------------------------------------------------------------

function startPrimary() {
  let shuttingDown = false;

  console.log(
    `[primary] pid ${process.pid} starting ${config.workers} workers ` +
      `(${config.reusePort ? 'SO_REUSEPORT' : 'shared handle'})`,
  );

  const children = [];

  if (config.reusePort) {
    // Each child binds its own listening socket. The kernel then distributes
    // incoming connections by 4-tuple hash, which spreads evenly even though a
    // single test only opens a handful of sockets.
    const spawn = (id) => {
      const child = fork(SELF, [], {
        env: { ...process.env, SPEEDTEST_CHILD: '1', SPEEDTEST_WORKER_ID: String(id) },
        stdio: 'inherit',
      });
      child.on('exit', (code, signal) => {
        if (shuttingDown) return;
        console.warn(`[primary] worker ${id} exited (${signal ?? code}); restarting`);
        children[id] = spawn(id);
      });
      return child;
    };
    for (let i = 0; i < config.workers; i += 1) children[i] = spawn(i);
  } else {
    // No SO_REUSEPORT on this platform, so fall back to a shared listening
    // handle. SCHED_NONE, not the default SCHED_RR: under round-robin the
    // primary accepts every connection and hands it off, making it the exact
    // single-threaded bottleneck we forked to avoid.
    cluster.schedulingPolicy = cluster.SCHED_NONE;
    for (let i = 0; i < config.workers; i += 1) {
      cluster.fork({ SPEEDTEST_WORKER_ID: String(i) });
    }
    cluster.on('exit', (worker, code, signal) => {
      if (shuttingDown) return;
      console.warn(`[primary] worker ${worker.process.pid} exited (${signal ?? code}); restarting`);
      cluster.fork();
    });
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) child?.kill('SIGTERM');
    for (const worker of Object.values(cluster.workers ?? {})) worker?.kill('SIGTERM');
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ---------------------------------------------------------------------------

if (config.workers > 1 && !IS_FORKED_CHILD && !cluster.isWorker) {
  startPrimary();
} else {
  startWorker();
}
