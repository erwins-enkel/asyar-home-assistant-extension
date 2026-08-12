import { describe, it, expect, vi } from 'vitest';
import { createConfigGate, createFailureBackoff } from './configGate';

/** A snapshot that only changes when `refresh` is allowed to land. */
function harness(initial: string | null = null) {
  let snapshot = initial;
  let pending: string | null = null;
  let resolveRefresh: (() => void) | null = null;

  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        resolveRefresh = () => {
          if (pending === '__fail__') {
            reject(new Error('pull failed'));
          } else {
            snapshot = pending;
            resolve();
          }
        };
      }),
  );

  return {
    refresh,
    read: () => snapshot,
    /** Queue what the next successful refresh will produce. */
    willReturn(v: string | null) {
      pending = v;
    },
    willFail() {
      pending = '__fail__';
    },
    settle() {
      resolveRefresh?.();
      resolveRefresh = null;
    },
  };
}

describe('createConfigGate', () => {
  it('pulls when the snapshot is empty', async () => {
    const h = harness(null);
    const gate = createConfigGate({ read: h.read, refresh: h.refresh });
    h.willReturn('token-1');

    const p = gate.get();
    h.settle();
    expect(await p).toBe('token-1');
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('serves the cached snapshot without pulling again', async () => {
    const h = harness('token-1');
    const gate = createConfigGate({ read: h.read, refresh: h.refresh });

    expect(await gate.get()).toBe('token-1');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('re-pulls after invalidate, even though the snapshot is non-null', async () => {
    const h = harness('dead-token');
    const gate = createConfigGate({ read: h.read, refresh: h.refresh });
    expect(await gate.get()).toBe('dead-token');

    gate.invalidate();
    h.willReturn('rotated-token');
    const p = gate.get();
    h.settle();

    expect(await p).toBe('rotated-token');
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  // The bug this whole module exists to prevent: a second caller arriving
  // while a refresh is in flight used to read the snapshot that refresh was
  // about to replace, and carry on with the credentials the server rejected.
  it('makes a concurrent caller join the in-flight pull instead of reading the stale snapshot', async () => {
    const h = harness('dead-token');
    const gate = createConfigGate({ read: h.read, refresh: h.refresh });
    await gate.get();

    gate.invalidate();
    h.willReturn('rotated-token');

    const first = gate.get();
    const second = gate.get(); // arrives while the pull is suspended
    h.settle();

    expect(await first).toBe('rotated-token');
    expect(await second).toBe('rotated-token');
    // Both callers shared one pull rather than starting a second.
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('stays stale when the pull fails, so the next call retries', async () => {
    const h = harness('dead-token');
    const gate = createConfigGate({ read: h.read, refresh: h.refresh });
    await gate.get();

    gate.invalidate();
    h.willFail();
    const failed = gate.get();
    h.settle();
    // Falls back to whatever is there rather than throwing at the caller.
    expect(await failed).toBe('dead-token');

    // Still stale: the next call must try again, not settle for the dead value.
    h.willReturn('rotated-token');
    const retry = gate.get();
    h.settle();
    expect(await retry).toBe('rotated-token');
    expect(h.refresh).toHaveBeenCalledTimes(2);
  });

  it('returns null when a pull produces nothing (never configured)', async () => {
    const h = harness(null);
    const gate = createConfigGate({ read: h.read, refresh: h.refresh });
    h.willReturn(null);

    const p = gate.get();
    h.settle();
    expect(await p).toBeNull();
  });
});

describe('createFailureBackoff', () => {
  it('does not back off before any failure', () => {
    const backoff = createFailureBackoff(30_000, () => 1_000);
    expect(backoff.isBackingOff()).toBe(false);
  });

  it('backs off inside the window', () => {
    let now = 1_000;
    const backoff = createFailureBackoff(30_000, () => now);
    backoff.recordFailure();
    now = 10_000;
    expect(backoff.isBackingOff()).toBe(true);
  });

  it('stops backing off once the window elapses', () => {
    let now = 1_000;
    const backoff = createFailureBackoff(30_000, () => now);
    backoff.recordFailure();
    now = 31_001;
    expect(backoff.isBackingOff()).toBe(false);
  });

  it('clears immediately on success', () => {
    let now = 1_000;
    const backoff = createFailureBackoff(30_000, () => now);
    backoff.recordFailure();
    backoff.recordSuccess();
    now = 2_000;
    expect(backoff.isBackingOff()).toBe(false);
  });
});
