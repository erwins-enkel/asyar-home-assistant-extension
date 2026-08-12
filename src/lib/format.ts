import type { Entity } from './types';

const DOMAIN_ICONS: Record<string, string> = {
  light: '💡',
  switch: '🔌',
  scene: '🎬',
  script: '📜',
  fan: '🌀',
  cover: '🪟',
  climate: '🌡️',
  media_player: '🔊',
  sensor: '📈',
  binary_sensor: '📡',
  lock: '🔒',
  camera: '📷',
  vacuum: '🧹',
  person: '👤',
  automation: '⚙️',
  input_boolean: '🔘',
  button: '🔘',
  device_tracker: '📍',
  weather: '⛅',
};

export function iconFor(domain: string): string {
  return DOMAIN_ICONS[domain] ?? '🏠';
}

/** Human-facing state: "On", "22.5 °C", "Home". */
export function stateLabel(entity: Entity): string {
  const s = entity.state;
  if (s === 'on') return 'On';
  if (s === 'off') return 'Off';
  if (s === 'unavailable') return 'Unavailable';
  if (s === 'unknown') return 'Unknown';
  if (entity.unit) return `${s} ${entity.unit}`;
  return s.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * What Enter will do, phrased for a search-result subtitle. Returns null for
 * read-only entities so callers can omit the hint rather than print "—".
 */
export function actionLabel(entity: Entity, service: string | null): string | null {
  if (!service) return null;
  if (entity.domain === 'scene') return 'Activate scene';
  if (entity.domain === 'script') return 'Run script';
  if (entity.domain === 'button' || entity.domain === 'input_button') return 'Press';
  if (service === 'turn_on') return 'Turn on';
  if (service === 'turn_off') return 'Turn off';
  return 'Toggle';
}

/** Subtitle for a global-search result: "Light · On · Turn off". */
export function resultSubtitle(entity: Entity, service: string | null): string {
  const domain = entity.domain.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const parts = [domain, stateLabel(entity)];
  const action = actionLabel(entity, service);
  if (action) parts.push(action);
  return parts.join(' · ');
}
