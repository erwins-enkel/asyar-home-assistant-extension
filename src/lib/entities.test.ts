import { describe, it, expect } from 'vitest';
import {
  domainOf,
  friendlyName,
  actionServiceFor,
  toEntity,
  parseDomainList,
  searchEntities,
} from './entities';
import type { Entity, HaState } from './types';

const state = (entity_id: string, s = 'on', attributes = {}): HaState => ({
  entity_id,
  state: s,
  attributes,
});

const entity = (entityId: string, name: string, s = 'on'): Entity =>
  toEntity(state(entityId, s, { friendly_name: name }));

describe('domainOf', () => {
  it('splits on the first dot', () => {
    expect(domainOf('light.kitchen_ceiling')).toBe('light');
  });

  it('returns empty for an id with no domain', () => {
    expect(domainOf('bogus')).toBe('');
  });
});

describe('friendlyName', () => {
  it('prefers the friendly_name attribute', () => {
    expect(friendlyName(state('light.a', 'on', { friendly_name: 'Kitchen Ceiling' }))).toBe(
      'Kitchen Ceiling',
    );
  });

  it('humanises the object id when friendly_name is missing', () => {
    expect(friendlyName(state('light.kitchen_ceiling'))).toBe('Kitchen Ceiling');
  });

  it('ignores a blank friendly_name rather than showing nothing', () => {
    expect(friendlyName(state('light.hall_lamp', 'on', { friendly_name: '   ' }))).toBe(
      'Hall Lamp',
    );
  });
});

describe('actionServiceFor', () => {
  it('turns an on light off', () => {
    expect(actionServiceFor('light.a', 'on')).toBe('turn_off');
  });

  it('turns an off light on', () => {
    expect(actionServiceFor('light.a', 'off')).toBe('turn_on');
  });

  it('falls back to toggle when the state is neither on nor off', () => {
    expect(actionServiceFor('light.a', 'unavailable')).toBe('toggle');
  });

  it('activates a scene with turn_on regardless of state', () => {
    expect(actionServiceFor('scene.evening', 'unknown')).toBe('turn_on');
  });

  it('presses a button', () => {
    expect(actionServiceFor('button.doorbell', 'unknown')).toBe('press');
  });

  it('returns null for read-only entities so callers omit the action', () => {
    expect(actionServiceFor('sensor.temperature', '21.5')).toBeNull();
    expect(actionServiceFor('binary_sensor.door', 'on')).toBeNull();
  });
});

describe('toEntity', () => {
  it('carries the unit through for sensors', () => {
    const e = toEntity(state('sensor.temp', '21.5', { unit_of_measurement: '°C' }));
    expect(e.unit).toBe('°C');
    expect(e.controllable).toBe(false);
  });

  it('marks toggleable domains controllable', () => {
    expect(toEntity(state('switch.desk')).controllable).toBe(true);
  });
});

describe('parseDomainList', () => {
  it('splits, trims, and lowercases', () => {
    expect(parseDomainList(' Light , switch ,SCENE ')).toEqual(['light', 'switch', 'scene']);
  });

  it('drops empty segments from trailing commas', () => {
    expect(parseDomainList('light,,switch,')).toEqual(['light', 'switch']);
  });
});

describe('searchEntities', () => {
  const all = [
    entity('light.kitchen', 'Kitchen'),
    entity('light.kitchen_counter', 'Kitchen Counter'),
    entity('sensor.kitchen_temp', 'Kitchen Temperature'),
    entity('light.hall', 'Hall'),
    entity('light.broken', 'Broken Lamp', 'unavailable'),
  ];
  const opts = { domains: ['light'], minQueryLength: 3 };

  it('contributes nothing below the minimum query length', () => {
    expect(searchEntities(all, 'ki', opts)).toEqual([]);
  });

  it('restricts to the configured domains', () => {
    const ids = searchEntities(all, 'kitchen', opts).map((s) => s.entity.entityId);
    expect(ids).not.toContain('sensor.kitchen_temp');
  });

  it('treats an empty domain list as no restriction', () => {
    const ids = searchEntities(all, 'kitchen', { ...opts, domains: [] }).map(
      (s) => s.entity.entityId,
    );
    expect(ids).toContain('sensor.kitchen_temp');
  });

  it('ranks an exact name match above a longer partial one', () => {
    const ids = searchEntities(all, 'kitchen', opts).map((s) => s.entity.entityId);
    expect(ids[0]).toBe('light.kitchen');
  });

  it('hides unavailable entities, which cannot be actioned anyway', () => {
    const ids = searchEntities(all, 'broken', opts).map((s) => s.entity.entityId);
    expect(ids).toEqual([]);
  });

  it('matches on entity id as a fallback', () => {
    const ids = searchEntities(all, 'hall', opts).map((s) => s.entity.entityId);
    expect(ids).toEqual(['light.hall']);
  });

  it('returns the computed score so the launcher can rank across extensions', () => {
    const scored = searchEntities(all, 'kitchen', opts);
    expect(scored[0].score).toBeGreaterThan(scored[scored.length - 1].score);
    expect(scored.every((s) => s.score > 0)).toBe(true);
  });

  it('caps the number of results so the launcher stays usable', () => {
    const many = Array.from({ length: 50 }, (_, i) => entity(`light.lamp_${i}`, `Lamp ${i}`));
    expect(searchEntities(many, 'lamp', opts)).toHaveLength(8);
  });
});
