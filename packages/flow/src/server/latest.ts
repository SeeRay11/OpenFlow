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

/**
 * One at a time, claimed synchronously.
 *
 * A button that starts something slow can be clicked again before the page has
 * had time to show that anything started; the claim is taken in the click
 * handler itself, so the second click finds it held and does nothing.
 */
export function exclusive() {
  let held = false
  return {
    /** Takes the claim. False when somebody already holds it. */
    enter() {
      if (held) return false
      held = true
      return true
    },
    /** Gives the claim back. */
    leave() {
      held = false
    },
  }
}
