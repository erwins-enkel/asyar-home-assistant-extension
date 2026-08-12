import type { Entity, HaState } from './types';

/** Domains where `turn_on`/`turn_off`/`toggle` are meaningful. */
const TOGGLEABLE = new Set([
  'light',
  'switch',
  'fan',
  'input_boolean',
  'automation',
  'siren',
  'humidifier',
]);

/** Domains that "run" rather than toggle — Enter should fire, not flip. */
const ACTIVATABLE = new Set(['scene', 'script', 'button', 'input_button']);

/** Entities HA reports but nobody wants cluttering a launcher. */
const UNAVAILABLE_STATES = new Set(['unavailable', 'unknown']);

export function domainOf(entityId: string): string {
  const i = entityId.indexOf('.');
  return i === -1 ? '' : entityId.slice(0, i);
}

/**
 * HA's `friendly_name` is usually set, but not always — fall back to the
 * object id with separators turned into spaces so the result is still
 * searchable and readable.
 */
export function friendlyName(state: HaState): string {
  const attr = state.attributes?.friendly_name;
  if (typeof attr === 'string' && attr.trim()) return attr.trim();
  const objectId = state.entity_id.slice(state.entity_id.indexOf('.') + 1);
  return objectId.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isControllable(entityId: string): boolean {
  const d = domainOf(entityId);
  return TOGGLEABLE.has(d) || ACTIVATABLE.has(d);
}

/**
 * The service Enter should call. Toggleables flip; activatables fire their
 * domain's run-service. Returns null when the entity is read-only, which is
 * how callers decide whether to offer an action at all.
 */
export function actionServiceFor(entityId: string, state: string): string | null {
  const d = domainOf(entityId);
  if (ACTIVATABLE.has(d)) {
    if (d === 'scene') return 'turn_on';
    if (d === 'script') return 'turn_on';
    return 'press';
  }
  if (TOGGLEABLE.has(d)) {
    // Prefer an explicit turn_on/turn_off over toggle: if HA's reported state
    // is stale, `toggle` sends the device the wrong way, while an explicit
    // call is idempotent in the direction the user just asked for.
    if (state === 'on') return 'turn_off';
    if (state === 'off') return 'turn_on';
    return 'toggle';
  }
  return null;
}

export function toEntity(state: HaState): Entity {
  const unit = state.attributes?.unit_of_measurement;
  return {
    entityId: state.entity_id,
    domain: domainOf(state.entity_id),
    name: friendlyName(state),
    state: state.state,
    unit: typeof unit === 'string' ? unit : undefined,
    controllable: isControllable(state.entity_id),
  };
}

export function parseDomainList(raw: string): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Ranks entities against a query. Exact name match first, then prefix, then
 * substring in the name, then substring in the entity id — so typing "kitchen"
 * puts "Kitchen" above "Kitchen Counter Motion Sensor", and matching the id is
 * a last resort rather than noise.
 */
export function scoreEntity(entity: Entity, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = entity.name.toLowerCase();
  const id = entity.entityId.toLowerCase();

  if (name === q) return 1;
  if (name.startsWith(q)) return 0.9;
  if (name.includes(q)) return 0.75;
  if (id.startsWith(q)) return 0.6;
  if (id.includes(q)) return 0.5;
  return 0;
}

export interface SearchOptions {
  domains: string[];
  minQueryLength: number;
  limit?: number;
}

export interface ScoredEntity {
  entity: Entity;
  score: number;
}

/**
 * The global-search contribution. Deliberately conservative: it returns
 * nothing until the query is long enough and skips unavailable entities,
 * because every result here competes with the user's apps and files.
 *
 * Returns the score alongside each entity. Note the launcher's Tauri search
 * path does NOT order external results by `ExtensionResult.score` — it
 * re-classifies them with its own tier ranker — so this ordering matters
 * mainly for choosing *which* few entities are worth contributing at all.
 */
export function searchEntities(
  entities: Entity[],
  query: string,
  options: SearchOptions,
): ScoredEntity[] {
  const q = query.trim();
  if (q.length < options.minQueryLength) return [];

  const allowed = new Set(options.domains);
  const scored = entities
    .filter((e) => allowed.size === 0 || allowed.has(e.domain))
    .filter((e) => !UNAVAILABLE_STATES.has(e.state))
    .map((e) => ({ entity: e, score: scoreEntity(e, q) }))
    .filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score || a.entity.name.localeCompare(b.entity.name));
  return scored.slice(0, options.limit ?? 8);
}
