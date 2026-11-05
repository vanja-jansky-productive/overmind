// A warm, stale-while-revalidate snapshot of the merged overmind.
//
// Building the merged overmind means local discovery (`overmind list --json`: one `ps` per
// session plus an osascript for iTerm tab titles, ~1-2s on a busy laptop) and a round-trip
// to every peer. Instead of making each page load wait on the slowest host, the server
// keeps the last merged result and refreshes it in the background every `refreshMs` for
// as long as someone asked within `idleAfterMs`. Only the very first request (or the first
// one after idling with no snapshot) waits for a build.
//
// A background tick builds with `force: false`: whether local discovery actually runs the CLI
// is lib/overmind.mjs's call (on a file change, or after its age bound / TTL). A change signal
// calls `poke(at)` so the rebuild lands when the change is due rather than on the next tick.

export function createSnapshot({
  build,
  refreshMs = 3000,
  idleAfterMs = 90 * 1000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logError = () => {},
}) {
  if (typeof build !== 'function') throw new TypeError('build must be a function');
  let snapshot = null; // { body, at }
  let refreshing = null;
  let lastAsked = 0;
  let timer = null;
  let pokeTimer = null;
  let pokeAt = Infinity;
  let stopped = false;

  function schedule() {
    clearTimer(timer);
    timer = null;
    if (stopped || now() - lastAsked > idleAfterMs) return; // nobody is watching
    timer = setTimer(() => {
      timer = null;
      refresh();
    }, refreshMs);
    timer?.unref?.();
  }

  /**
   * Rebuild now (de-duplicated). Resolves the new snapshot, or the old one if the build failed.
   * `fresh`: the build must start after this call (a change was just made) — an in-flight
   * one may predate it, so a new build is chained behind it. `force` goes to `build`.
   */
  function refresh({ fresh = false, force = false } = {}) {
    if (refreshing && fresh) return refreshing.then(() => refresh({ force }));
    if (refreshing) return refreshing;
    refreshing = Promise.resolve()
      .then(() => build({ force }))
      .then((body) => {
        snapshot = { body, at: now() };
        return snapshot;
      })
      .catch((err) => {
        logError(err, 'overmind refresh');
        if (!snapshot) throw err;
        return snapshot;
      })
      .finally(() => {
        refreshing = null;
        schedule();
      });
    return refreshing;
  }

  /** The body to serve: `{ ...merged, snapshotAt }`. Waits only when there is nothing yet. */
  async function get() {
    const wasIdle = now() - lastAsked > idleAfterMs;
    lastAsked = now();
    if (!snapshot) {
      const snap = await refresh();
      return { ...snap.body, snapshotAt: snap.at };
    }
    if (wasIdle || (!timer && !refreshing)) refresh();
    return { ...snapshot.body, snapshotAt: snapshot.at };
  }

  /** The current body without counting as a request (no warming); null before the first build. */
  function peek() {
    return snapshot ? { ...snapshot.body, snapshotAt: snapshot.at } : null;
  }

  /**
   * A change is due at `at` (ms): build then, if someone is watching. Pokes coalesce — one
   * pending build, at the earliest time asked. A build in flight when it fires may predate the
   * change, so the poked one is chained behind it.
   */
  function poke(at) {
    if (stopped || !snapshot || now() - lastAsked > idleAfterMs) return;
    if (pokeTimer && pokeAt <= at) return;
    clearTimer(pokeTimer);
    pokeAt = at;
    arm();
  }

  // Timers run on the monotonic clock and can fire a millisecond before `at` by `now()`: a build
  // then would still find the change not due and serve the dirty list until the next tick.
  function arm() {
    pokeTimer = setTimer(() => {
      if (now() < pokeAt) return arm();
      pokeTimer = null;
      pokeAt = Infinity;
      refresh({ fresh: true }).catch(() => {});
    }, Math.max(0, pokeAt - now()));
    pokeTimer?.unref?.();
  }

  function stop() {
    stopped = true;
    clearTimer(timer);
    clearTimer(pokeTimer);
    timer = pokeTimer = null;
  }

  return { get, peek, refresh, poke, stop };
}
