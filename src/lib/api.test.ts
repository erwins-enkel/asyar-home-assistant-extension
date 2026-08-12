import { describe, it, expect } from 'vitest';
import {
  normalizeBaseUrl,
  statesRequest,
  callServiceRequest,
  parseStates,
  describeHttpError,
} from './api';

const cfg = { baseUrl: 'https://ha.example.ts.net', token: 'tok' };

describe('normalizeBaseUrl', () => {
  it('adds https when the user pastes a bare host', () => {
    expect(normalizeBaseUrl('ha.example.ts.net')).toBe('https://ha.example.ts.net');
  });

  it('keeps an explicit http scheme, since local instances are often plain', () => {
    expect(normalizeBaseUrl('http://10.0.0.5:8123')).toBe('http://10.0.0.5:8123');
  });

  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://ha.example.ts.net///')).toBe('https://ha.example.ts.net');
  });

  it('strips a trailing /api so the user can paste either form', () => {
    expect(normalizeBaseUrl('https://ha.example.ts.net/api')).toBe('https://ha.example.ts.net');
  });

  it('returns empty for blank input rather than a bare scheme', () => {
    expect(normalizeBaseUrl('   ')).toBe('');
  });
});

describe('statesRequest', () => {
  it('targets /api/states with a bearer token', () => {
    const req = statesRequest(cfg);
    expect(req.url).toBe('https://ha.example.ts.net/api/states');
    expect(req.options.method).toBe('GET');
    expect(req.options.headers.Authorization).toBe('Bearer tok');
  });
});

describe('callServiceRequest', () => {
  it('puts entity_id in the body, not the path', () => {
    const req = callServiceRequest(cfg, 'light', 'turn_on', 'light.kitchen');
    expect(req.url).toBe('https://ha.example.ts.net/api/services/light/turn_on');
    expect(JSON.parse(req.options.body!)).toEqual({ entity_id: 'light.kitchen' });
  });

  it('merges extra service data alongside the entity', () => {
    const req = callServiceRequest(cfg, 'light', 'turn_on', 'light.kitchen', {
      brightness_pct: 40,
    });
    expect(JSON.parse(req.options.body!)).toEqual({
      brightness_pct: 40,
      entity_id: 'light.kitchen',
    });
  });

  it('omits entity_id entirely for entity-less services', () => {
    const req = callServiceRequest(cfg, 'homeassistant', 'restart');
    expect(JSON.parse(req.options.body!)).toEqual({});
  });
});

describe('parseStates', () => {
  it('keeps well-formed entities', () => {
    const body = JSON.stringify([
      { entity_id: 'light.a', state: 'on', attributes: {} },
      { entity_id: 'switch.b', state: 'off', attributes: {} },
    ]);
    expect(parseStates(body).map((s) => s.entity_id)).toEqual(['light.a', 'switch.b']);
  });

  it('drops malformed rows instead of throwing', () => {
    const body = JSON.stringify([{ entity_id: 'light.a', state: 'on' }, null, 42, {}]);
    expect(parseStates(body)).toHaveLength(1);
  });

  it('returns empty when the payload is not an array', () => {
    expect(parseStates(JSON.stringify({ message: 'nope' }))).toEqual([]);
  });
});

describe('describeHttpError', () => {
  it('explains what a 401 actually means for the user', () => {
    expect(describeHttpError(401, 'Unauthorized')).toMatch(/token/i);
  });

  it('points a 404 at the URL rather than the token', () => {
    expect(describeHttpError(404, 'Not Found')).toMatch(/URL/i);
  });

  it('falls back to the raw status for anything else', () => {
    expect(describeHttpError(503, 'Service Unavailable')).toBe(
      'Home Assistant returned 503 Service Unavailable',
    );
  });
});
