/**
 * Credential access with refresh-on-demand.
 *
 * Extracted from the worker as a pure factory because it is the part that kept
 * going wrong: the worker module cannot be imported by tests (the SDK asserts
 * `window.__ASYAR_ROLE__` at load), so every bug in this state machine reached
 * runtime unexamined. Everything here is injectable and covered by tests.
 */

export interface ConfigGateDeps<T> {
  /** Read credentials out of the current (possibly stale) snapshot. */
  read: () => T | null;
  /** Pull a fresh snapshot from the host. May reject. */
  refresh: () => Promise<void>;
}

export interface ConfigGate<T> {
  /** Credentials, refreshing first when the snapshot is missing or stale. */
  get(): Promise<T | null>;
  /** Mark the snapshot stale — call when the server rejects the credentials. */
  invalidate(): void;
}

export function createConfigGate<T>(deps: ConfigGateDeps<T>): ConfigGate<T> {
  let stale = false;
  let pull: Promise<void> | null = null;

  function startPull(): Promise<void> {
    pull ??= deps
      .refresh()
      // Clear the staleness flag only once fresh data has actually landed.
      // Clearing it before the await let a second caller read the snapshot
      // that was about to be replaced and carry on with dead credentials.
      .then(() => {
        stale = false;
      })
      .catch(() => {
        // Leave `stale` set so the next caller retries rather than silently
        // settling for the credentials the server just rejected.
      })
      .finally(() => {
        pull = null;
      });
    return pull;
  }

  return {
    async get(): Promise<T | null> {
      // Join a pull already in flight instead of racing it. Without this a
      // concurrent caller takes the cached path and gets the very snapshot
      // the in-flight refresh exists to replace.
      if (pull) await pull;

      if (!stale) {
        const cached = deps.read();
        if (cached) return cached;
      }

      await startPull();
      return deps.read();
    },

    invalidate(): void {
      stale = true;
    },
  };
}

/**
 * Suppresses speculative retries for a window after a failure.
 *
 * A failed fetch caches nothing, and de-duplicating only *concurrent* calls is
 * not enough: an auth rejection returns fast, so keystrokes arrive sequentially
 * and each one starts a new request.
 */
export interface FailureBackoff {
  recordFailure(): void;
  recordSuccess(): void;
  isBackingOff(): boolean;
}

export function createFailureBackoff(
  windowMs: number,
  now: () => number = Date.now,
): FailureBackoff {
  let lastFailureAt = 0;
  return {
    recordFailure(): void {
      lastFailureAt = now();
    },
    recordSuccess(): void {
      lastFailureAt = 0;
    },
    isBackingOff(): boolean {
      return lastFailureAt > 0 && now() - lastFailureAt < windowMs;
    },
  };
}
