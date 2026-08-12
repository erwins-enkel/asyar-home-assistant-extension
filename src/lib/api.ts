import type { HaConfig, HaState } from './types';

export interface ApiRequest {
  url: string;
  options: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    timeout?: number;
  };
}

/**
 * Users paste all sorts of things into the URL field. Accept a bare host, a
 * trailing slash, or a URL that already ends in `/api` — and normalise them all
 * to a scheme-qualified origin with no trailing slash, so callers can append
 * `/api/...` unconditionally.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/api$/i, '');
  return url;
}

function headers(config: HaConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };
}

export function statesRequest(config: HaConfig): ApiRequest {
  return {
    url: `${normalizeBaseUrl(config.baseUrl)}/api/states`,
    options: { method: 'GET', headers: headers(config), timeout: 15_000 },
  };
}

export function callServiceRequest(
  config: HaConfig,
  domain: string,
  service: string,
  entityId?: string,
  data?: Record<string, unknown>,
): ApiRequest {
  const body: Record<string, unknown> = { ...(data ?? {}) };
  if (entityId) body.entity_id = entityId;
  return {
    url: `${normalizeBaseUrl(config.baseUrl)}/api/services/${domain}/${service}`,
    options: {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify(body),
      timeout: 15_000,
    },
  };
}

export function parseStates(body: string): HaState[] {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (s): s is HaState =>
      !!s && typeof s === 'object' && typeof (s as HaState).entity_id === 'string',
  );
}

/**
 * Turns a non-2xx into a message worth showing a user. HA answers 401 for a
 * bad or revoked token, which is by far the most likely failure and deserves
 * better than "HTTP 401".
 */
export function describeHttpError(status: number, statusText: string): string {
  if (status === 401 || status === 403) {
    return 'Home Assistant rejected the token. Create a new long-lived access token and update the extension preferences.';
  }
  if (status === 404) {
    return 'Not found — check that the Home Assistant URL points at the base of the instance, not a dashboard.';
  }
  return `Home Assistant returned ${status} ${statusText}`.trim();
}
