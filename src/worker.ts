import { ExtensionContext as WorkerExtensionContext, extensionBridge } from 'asyar-sdk/worker';
import type {
  Extension,
  ExtensionContext,
  ExtensionResult,
  INetworkService,
  IToolsService,
  IActionService,
  ILogService,
  ManifestTool,
} from 'asyar-sdk/contracts';
import manifest from '../manifest.json';

import {
  statesRequest,
  callServiceRequest,
  parseStates,
  normalizeBaseUrl,
  describeHttpError,
  type ApiRequest,
} from './lib/api';
import {
  toEntity,
  searchEntities,
  actionServiceFor,
  parseDomainList,
  domainOf,
} from './lib/entities';
import { iconFor, resultSubtitle } from './lib/format';
import { createConfigGate, createFailureBackoff } from './lib/configGate';
import type { EntitiesReply, Entity, HaConfig, TogglePayload } from './lib/types';

const extensionId = resolveExtensionId();
const ctx = new WorkerExtensionContext();
ctx.setExtensionId(extensionId);

const network = ctx.getService<INetworkService>('network');
const tools = ctx.getService<IToolsService>('tools');
const actions = ctx.getService<IActionService>('actions');
const log = ctx.getService<ILogService>('log');

const TOGGLE_ACTION_ID = 'ha-toggle-entity';

// ─── preferences ───────────────────────────────────────────────────────────
// The worker must pull its own preferences. The bundle is *delivered* here
// fine — `pickExtensionIframe` falls back to the worker when no view is
// mounted — but the SDK then drops it: ExtensionBridge only applies
// `preferences:set-all` to contexts in `activeContexts`, and a context
// self-registers there via `notifyBridgeIfAvailable`, which is a no-op in
// ExtensionContextCore and is overridden only by the *view* ExtensionContext.
// So in a worker the bundle lands under a pending sentinel and is discarded.
// (docs/reference/sdk/preferences.md claims both roles stay in sync; that is
// wrong for the worker.)
const configGate = createConfigGate<HaConfig>({
  read: readConfigFromSnapshot,
  refresh: () => ctx.preferences.refresh().then(() => undefined),
});

function prefs(): Record<string, unknown> {
  return (ctx.preferences.values as Record<string, unknown> | undefined) ?? {};
}

function readConfigFromSnapshot(): HaConfig | null {
  const baseUrl = normalizeBaseUrl(String(prefs().baseUrl ?? ''));
  const token = String(prefs().token ?? '').trim();
  return baseUrl && token ? { baseUrl, token } : null;
}

/** Credentials, pulling a fresh bundle when missing or known-stale. */
function config(): Promise<HaConfig | null> {
  return configGate.get();
}

function searchDomains(): string[] {
  const raw = String(prefs().searchDomains ?? '');
  return parseDomainList(raw);
}

function minQueryLength(): number {
  const n = Number(prefs().minQueryLength ?? 3);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

// ─── state cache ───────────────────────────────────────────────────────────
// A launcher search must answer within a keystroke, so search never awaits the
// network — it reads this cache, which the scheduled `refresh` command and any
// view interaction keep warm. `null` means "never loaded", which the views
// surface as a setup hint rather than an empty list.
const CACHE_TTL_MS = 60_000;
// A failed fetch caches nothing, and `inFlight` only dedups *concurrent* calls
// — a 401 returns fast, so successive keystrokes are sequential. Without this
// backoff, typing "kitchen light" against an unreachable instance fires one
// request per character.
const backoff = createFailureBackoff(30_000);
let cache: { entities: Entity[]; at: number } | null = null;
let inFlight: Promise<Entity[]> | null = null;

async function request(req: ApiRequest): Promise<string> {
  const res = await network.fetch(req.url, req.options);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) configGate.invalidate();
    throw new Error(describeHttpError(res.status, res.statusText));
  }
  return res.body;
}

async function fetchEntities(): Promise<Entity[]> {
  try {
    const cfg = await config();
    if (!cfg) throw new Error('Home Assistant URL and token are not configured yet.');
    const body = await request(statesRequest(cfg));
    const entities = parseStates(body).map(toEntity);
    cache = { entities, at: Date.now() };
    backoff.recordSuccess();
    return entities;
  } catch (err) {
    backoff.recordFailure();
    throw err;
  }
}

/** Cached read. Concurrent callers share one in-flight request. */
async function loadEntities(force = false): Promise<Entity[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entities;
  if (inFlight) return inFlight;
  inFlight = fetchEntities().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function callService(
  domain: string,
  service: string,
  entityId?: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const cfg = await config();
  if (!cfg) throw new Error('Home Assistant URL and token are not configured yet.');
  await request(callServiceRequest(cfg, domain, service, entityId, data));
  // The call changed the world; the cache is now a lie. Drop it rather than
  // patching it optimistically — HA may have applied something different.
  cache = null;
}

// ─── global search ─────────────────────────────────────────────────────────
function buildResults(entities: Entity[], query: string): ExtensionResult[] {
  const matches = searchEntities(entities, query, {
    domains: searchDomains(),
    minQueryLength: minQueryLength(),
  });

  return matches.map(({ entity, score }) => {
    const service = actionServiceFor(entity.entityId, entity.state);
    const payload: TogglePayload = {
      entityId: entity.entityId,
      domain: entity.domain,
      service: service ?? 'toggle',
    };
    return {
      // Display/compat only — the Tauri search path re-classifies external
      // results with its own tier ranker and never reads this field. Passing
      // the real relevance costs nothing and keeps the browser fallback sane,
      // but the leverage is in *which* entities we return, not their scores.
      score,
      title: entity.name,
      subtitle: resultSubtitle(entity, service),
      type: 'result' as const,
      icon: iconFor(entity.domain),
      action: () => {},
      ...(service ? { actionId: TOGGLE_ACTION_ID, actionPayload: payload } : {}),
    };
  });
}

// ─── AI tools ──────────────────────────────────────────────────────────────
function registerTools(): void {
  const byId = (id: string): ManifestTool | undefined =>
    (manifest.tools as ManifestTool[] | undefined)?.find((t) => t.id === id);

  const reg = (id: string, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
    const tool = byId(id);
    if (!tool) return;
    // Must not float: a rejected registerTool (IPC timeout, permission denial)
    // would reach the SDK's uncaught handler and be reported to the user as an
    // extension error during boot.
    void tools
      .registerTool(tool, (args) => handler((args ?? {}) as Record<string, unknown>))
      .catch((err) => log.warn(`[home-assistant] registerTool ${id} failed: ${String(err)}`));
  };

  reg('ha-list-entities', async (a) => {
    const entities = await loadEntities();
    const domain = String(a.domain ?? '')
      .trim()
      .toLowerCase();
    const query = String(a.query ?? '')
      .trim()
      .toLowerCase();
    const filtered = entities
      .filter((e) => !domain || e.domain === domain)
      .filter(
        (e) =>
          !query ||
          e.name.toLowerCase().includes(query) ||
          e.entityId.toLowerCase().includes(query),
      );
    // A whole-house dump can run to thousands of entities and blow the agent's
    // context; cap it and report the true total rather than the capped one, so
    // the agent knows to narrow its query instead of assuming it saw everything.
    const LIMIT = 200;
    const shown = filtered.slice(0, LIMIT);
    return {
      count: shown.length,
      totalMatching: filtered.length,
      truncated: filtered.length > LIMIT,
      entities: shown.map((e) => ({
        entityId: e.entityId,
        name: e.name,
        state: e.unit ? `${e.state} ${e.unit}` : e.state,
      })),
    };
  });

  reg('ha-get-state', async (a) => {
    const entityId = String(a.entityId ?? '').trim();
    if (!entityId) return { error: 'entityId is required.' };
    const entity = (await loadEntities()).find((e) => e.entityId === entityId);
    if (!entity) return { error: `No entity with id '${entityId}'.` };
    return {
      entityId: entity.entityId,
      name: entity.name,
      state: entity.state,
      unit: entity.unit,
      domain: entity.domain,
    };
  });

  reg('ha-call-service', async (a) => {
    const domain = String(a.domain ?? '').trim();
    const service = String(a.service ?? '').trim();
    const entityId = String(a.entityId ?? '').trim() || undefined;
    if (!domain || !service) return { error: 'domain and service are required.' };
    // Guard against the agent inventing a mismatched pair, which HA would
    // accept as a 200 while doing nothing to the entity the user meant.
    if (entityId && domainOf(entityId) !== domain && domain !== 'homeassistant') {
      return {
        error: `Entity '${entityId}' is in domain '${domainOf(entityId)}', not '${domain}'.`,
      };
    }
    const data = (a.data ?? undefined) as Record<string, unknown> | undefined;
    try {
      await callService(domain, service, entityId, data);
      return { ok: true, called: `${domain}.${service}`, entityId };
    } catch (err) {
      return { error: String((err as Error).message ?? err) };
    }
  });
}

// ─── extension shell ───────────────────────────────────────────────────────
class HomeAssistantExt implements Extension {
  async initialize(_c: ExtensionContext): Promise<void> {}
  async activate(): Promise<void> {}
  async deactivate(): Promise<void> {}

  async executeCommand(id: string): Promise<unknown> {
    if (id === 'refresh') {
      // Scheduled tick. A failure here is not worth a toast — the user did not
      // ask for it — so keep the stale cache and let the next tick retry.
      try {
        await loadEntities(true);
      } catch {
        /* offline, VPN down, token rotated: retry on the next tick */
      }
    }
    return undefined;
  }

  async search(query: string): Promise<ExtensionResult[]> {
    // readConfig(), not config(): a keystroke must never await an IPC pull.
    // The boot-time pull below has normally landed by now.
    if (!readConfigFromSnapshot()) return [];
    if (query.trim().length < minQueryLength()) return [];
    // Never await the network on the search path. If the cache is cold, warm
    // it in the background and contribute nothing this keystroke — unless a
    // recent failure says the instance is unreachable, in which case stay quiet
    // rather than firing a request per character.
    if (!backoff.isBackingOff()) void loadEntities().catch(() => {});
    if (!cache) return [];
    return buildResults(cache.entities, query);
  }
}

// ─── view → worker RPC ─────────────────────────────────────────────────────
// Returns a result envelope rather than throwing: a rejection thrown across
// the view↔worker RPC boundary arrives as an empty reply, so the view would
// only ever learn "something failed" and never what. The envelope carries the
// real message — usually a bad token or an unreachable host — to the panel.
ctx.onRequest<{ force?: boolean } | undefined, EntitiesReply>('getEntities', async (args) => {
  try {
    const entities = await loadEntities(args?.force === true);
    return { ok: true, entities };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    log.error(
      `[home-assistant] getEntities failed: ${message} | pref keys seen: ` +
        `${JSON.stringify(Object.keys(prefs()))} | extensionId=${extensionId}`,
    );
    return { ok: false, entities: [], error: message };
  }
});

ctx.onRequest<
  { domain: string; service: string; entityId?: string; data?: Record<string, unknown> },
  { ok: boolean; error?: string }
>('callService', async (args) => {
  try {
    await callService(args.domain, args.service, args.entityId, args.data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
});

// Enter on a global-search result lands here.
actions.registerActionHandler(TOGGLE_ACTION_ID, async (payload) => {
  const p = payload as TogglePayload | undefined;
  if (!p?.entityId) return;
  try {
    await callService(p.domain, p.service, p.entityId);
  } catch {
    /* surfaced by the views; a failed toggle from search stays quiet */
  }
});

const ext = new HomeAssistantExt();
extensionBridge.registerManifest(
  manifest as unknown as Parameters<typeof extensionBridge.registerManifest>[0],
);
extensionBridge.registerExtensionImplementation(extensionId, ext);
registerTools();
// Pull the preference bundle immediately so the first keystroke into the
// launcher already has credentials to work with (search must not await IPC).
void configGate.get().catch(() => {});

// No manual `asyar:extension:loaded` post: ExtensionContextCore.setExtensionId
// already emits it (with the resolved role), and posting again causes a second
// readiness ack and a duplicate preference push.

function resolveExtensionId(): string {
  const fallback = 'org.erwinsenkel.home-assistant';
  if (
    window.location.hostname === 'localhost' ||
    window.location.hostname === 'asyar-extension.localhost'
  ) {
    return window.location.pathname.split('/').filter(Boolean)[0] || fallback;
  }
  return window.location.hostname || fallback;
}
