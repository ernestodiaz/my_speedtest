import { NO_STORE } from '../headers.js';

/**
 * Latency probe. 204 with no body: the reply is a single small packet, so what
 * the client times is as close to a round trip as HTTP allows.
 *
 * Nagle's algorithm must be off -- it delays small writes waiting for more data
 * to coalesce, which would add tens of milliseconds of pure artifact to a
 * measurement whose whole point is sub-millisecond resolution.
 */
export function handlePing(req, res) {
  res.socket?.setNoDelay(true);
  res.writeHead(204, NO_STORE);
  res.end();
}
