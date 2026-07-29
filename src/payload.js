import { randomFillSync } from 'node:crypto';
import { config } from './config.js';

// Randomness is generated exactly once. Producing fresh random bytes per chunk
// caps throughput around 1-2 GB/s, which would mean measuring the CSPRNG
// rather than the network.
//
// Retransmitting the same buffer is safe against compression skew: gzip's
// window is 32 KiB, far smaller than the buffer, so it cannot see the repeat.
// Response compression is disabled outright anyway (there is no middleware).
const buffer = Buffer.allocUnsafe(config.payloadBytes);
randomFillSync(buffer);

// Pre-sliced views over the shared buffer. Handing these to res.write() copies
// nothing in JS and allocates nothing per chunk in steady state.
const chunks = [];
for (let offset = 0; offset < buffer.length; offset += config.chunkBytes) {
  chunks.push(buffer.subarray(offset, Math.min(offset + config.chunkBytes, buffer.length)));
}

export function chunkAt(index) {
  return chunks[index % chunks.length];
}

export const payloadInfo = {
  bytes: buffer.length,
  chunkBytes: config.chunkBytes,
  chunkCount: chunks.length,
};
