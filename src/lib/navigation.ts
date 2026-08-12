/**
 * Keyboard navigation for the entity list.
 *
 * A view panel does not get free keyboard handling: the launcher forwards
 * arrows and Enter as an `asyar:view:keydown` postMessage when the launcher
 * window holds focus, and the same keys arrive as native keydown events when
 * focus is inside the iframe. Both sources funnel through `keyIntent` so the
 * selection behaves identically either way.
 */

export type KeyIntent = 'up' | 'down' | 'activate' | 'refresh' | 'top' | 'bottom';

/** Clamp an index into [0, length-1]; returns 0 for an empty list. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

/** Pure reducer for a movement intent over a list of `length` rows. */
export function nextIndex(length: number, current: number, intent: KeyIntent): number {
  if (length <= 0) return 0;
  const max = length - 1;
  switch (intent) {
    case 'down':
      return Math.min(max, current + 1);
    case 'up':
      return Math.max(0, current - 1);
    case 'top':
      return 0;
    case 'bottom':
      return max;
    default:
      return clampIndex(current, length);
  }
}

/**
 * Map a keystroke to an intent, or null for keys the view does not own — those
 * must keep their default behaviour so typing still reaches the search bar.
 */
export function keyIntent(e: { key: string; meta?: boolean; ctrl?: boolean }): KeyIntent | null {
  const mod = e.meta === true || e.ctrl === true;
  switch (e.key) {
    case 'ArrowDown':
      return 'down';
    case 'ArrowUp':
      return 'up';
    case 'Home':
      return 'top';
    case 'End':
      return 'bottom';
    case 'Enter':
      return 'activate';
  }
  if ((e.key === 'r' || e.key === 'R') && mod) return 'refresh';
  return null;
}
