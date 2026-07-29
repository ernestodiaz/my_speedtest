/**
 * Counts concurrently active test streams so a single client cannot pin the
 * server open indefinitely.
 *
 * tryAcquire() returns a release function, or null when the cap is reached.
 * The release is idempotent: stream teardown can fire from several directions
 * (client abort, byte ceiling, time ceiling, socket error) and each of them
 * calls it.
 */
export function createLimiter(max) {
  let active = 0;

  return {
    get active() {
      return active;
    },
    get max() {
      return max;
    },
    tryAcquire() {
      if (active >= max) return null;
      active += 1;
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}
