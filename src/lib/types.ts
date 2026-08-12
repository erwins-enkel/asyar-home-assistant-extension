/** A Home Assistant entity as returned by `GET /api/states`. */
export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

/** The subset of an entity the UI and search actually care about. */
export interface Entity {
  entityId: string;
  domain: string;
  name: string;
  state: string;
  /** Unit of measurement, for sensors that report one. */
  unit?: string;
  /** Whether `toggle`/`turn_on`/`turn_off` are meaningful for this entity. */
  controllable: boolean;
}

/** Payload handed to the search-result action handler. Must survive JSON. */
export interface TogglePayload {
  entityId: string;
  domain: string;
  /** Chosen at result-build time so the handler stays dumb. */
  service: string;
}

export interface HaConfig {
  baseUrl: string;
  token: string;
}

/**
 * Reply envelope for the `getEntities` RPC. The worker returns this instead of
 * throwing: a rejection thrown across the view↔worker boundary arrives as an
 * empty reply, so the view could only ever learn *that* something failed, not
 * what. Carrying the message keeps "bad token" distinguishable from "host
 * unreachable" in the panel.
 */
export interface EntitiesReply {
  ok: boolean;
  entities: Entity[];
  error?: string;
}
