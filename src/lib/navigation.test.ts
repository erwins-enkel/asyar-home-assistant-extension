import { describe, it, expect } from 'vitest';
import { clampIndex, nextIndex, keyIntent } from './navigation';

describe('clampIndex', () => {
  it('returns 0 for an empty list', () => {
    expect(clampIndex(5, 0)).toBe(0);
  });

  it('clamps past the end', () => {
    expect(clampIndex(99, 3)).toBe(2);
  });

  it('clamps below zero', () => {
    expect(clampIndex(-4, 3)).toBe(0);
  });
});

describe('nextIndex', () => {
  it('moves down', () => {
    expect(nextIndex(5, 1, 'down')).toBe(2);
  });

  it('stops at the last row rather than wrapping', () => {
    expect(nextIndex(5, 4, 'down')).toBe(4);
  });

  it('stops at the first row rather than wrapping', () => {
    expect(nextIndex(5, 0, 'up')).toBe(0);
  });

  it('jumps to the ends', () => {
    expect(nextIndex(5, 2, 'top')).toBe(0);
    expect(nextIndex(5, 2, 'bottom')).toBe(4);
  });

  it('clamps a stale index when the list shrank under it', () => {
    expect(nextIndex(2, 9, 'activate')).toBe(1);
  });

  it('is safe on an empty list', () => {
    expect(nextIndex(0, 3, 'down')).toBe(0);
  });
});

describe('keyIntent', () => {
  it('maps arrows and Enter', () => {
    expect(keyIntent({ key: 'ArrowDown' })).toBe('down');
    expect(keyIntent({ key: 'ArrowUp' })).toBe('up');
    expect(keyIntent({ key: 'Enter' })).toBe('activate');
  });

  it('maps Home/End', () => {
    expect(keyIntent({ key: 'Home' })).toBe('top');
    expect(keyIntent({ key: 'End' })).toBe('bottom');
  });

  it('maps mod+R to refresh, but bare r to nothing', () => {
    expect(keyIntent({ key: 'r', meta: true })).toBe('refresh');
    expect(keyIntent({ key: 'r', ctrl: true })).toBe('refresh');
    expect(keyIntent({ key: 'r' })).toBeNull();
  });

  it('ignores printable keys so typing still reaches the search bar', () => {
    expect(keyIntent({ key: 'a' })).toBeNull();
    expect(keyIntent({ key: ' ' })).toBeNull();
    expect(keyIntent({ key: 'Escape' })).toBeNull();
  });
});
