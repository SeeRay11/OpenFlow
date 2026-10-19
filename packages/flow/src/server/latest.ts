/**
 * Newest call wins.
 *
 * Several callers in the page start the same read more than once (a heartbeat
 * and a notice both probing the host, a list refreshed after a save and again
 * after a run) and the answers come back in any order. Each call takes a ticket
 * from `begin()` and writes its result only while the ticket is still current,
 * so an older answer can neither overwrite a newer one nor clear the state the
 * newer call is still waiting on.
 */
export function latest() {
  let count = 0
  return {
    /** Starts a call. The returned function says whether no later call (and no `cancel`) has happened since. */
    begin() {
      const mine = ++count
      return () => mine === count
    },
    /** Makes every call started so far stale, without starting one. */
    cancel() {
      count++
    },
  }
}
