import os from 'node:os';

const KiB = 1024;
const MiB = 1024 * 1024;
const GiB = 1024 * 1024 * 1024;

function num(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} is not a number`);
  }
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|on)$/i.test(raw);
}

function str(name, def) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : raw;
}

const cpus =
  typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length || 1;

export const config = {
  port: num('PORT', 8080, { min: 1, max: 65535 }),
  host: str('HOST', '0.0.0.0'),

  // One process cannot saturate a multi-gig link -- the receive path in
  // particular is CPU bound on materializing inbound Buffers. Scale across
  // cores instead. See src/server.js for how the load is distributed.
  workers: num('WORKERS', Math.max(1, Math.min(cpus, 8)), { min: 1, max: 64 }),
  // SO_REUSEPORT gives each worker its own accept queue, hashed by 4-tuple.
  // Linux/FreeBSD only; elsewhere we fall back to a shared listening handle.
  reusePort: bool('REUSE_PORT', process.platform === 'linux'),

  // Filled with randomness once at startup and retransmitted forever.
  payloadBytes: num('PAYLOAD_BYTES', 8 * MiB, { min: 64 * KiB, max: 256 * MiB }),
  // Size of a single res.write(). Large writes keep the syscall count low.
  chunkBytes: num('CHUNK_BYTES', 512 * KiB, { min: 16 * KiB, max: 16 * MiB }),

  // Client-side test parameters. Served to the browser via /info so the whole
  // methodology is configured in exactly one place.
  testDurationMs: num('TEST_DURATION_MS', 12000, { min: 1000, max: 120000 }),
  warmupMs: num('WARMUP_MS', 2000, { min: 0, max: 30000 }),
  parallelStreams: num('PARALLEL_STREAMS', 6, { min: 1, max: 32 }),
  pingCount: num('PING_COUNT', 20, { min: 3, max: 200 }),
  pingWarmup: num('PING_WARMUP', 2, { min: 0, max: 50 }),
  // Per-POST body size on the non-streaming upload fallback path.
  uploadChunkBytes: num('UPLOAD_CHUNK_BYTES', 32 * MiB, { min: 256 * KiB, max: 256 * MiB }),

  // Safety ceilings. /download is a bandwidth cannon and /upload an unbounded
  // sink; without these a single stuck or hostile client holds them open.
  //
  // Note: enforced PER WORKER, since a shared counter would need IPC on the hot
  // path. The server-wide ceiling is this value times WORKERS.
  maxConcurrentStreams: num('MAX_CONCURRENT_STREAMS', 64, { min: 1, max: 4096 }),
  maxStreamMs: num('MAX_STREAM_MS', 60000, { min: 1000, max: 600000 }),
  maxStreamBytes: num('MAX_STREAM_BYTES', 128 * GiB, { min: 1 * MiB }),
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 64 * GiB, { min: 1 * MiB }),
};

// A chunk is a view into the shared payload, so it cannot be larger than it.
if (config.chunkBytes > config.payloadBytes) {
  config.chunkBytes = config.payloadBytes;
}

// Trimming the warm-up must leave a measurement window behind.
if (config.warmupMs >= config.testDurationMs) {
  config.warmupMs = Math.floor(config.testDurationMs / 4);
}

// Parameters the browser needs. Everything else stays server-side.
export function clientConfig() {
  return {
    testDurationMs: config.testDurationMs,
    warmupMs: config.warmupMs,
    parallelStreams: config.parallelStreams,
    pingCount: config.pingCount,
    pingWarmup: config.pingWarmup,
    uploadChunkBytes: config.uploadChunkBytes,
  };
}
