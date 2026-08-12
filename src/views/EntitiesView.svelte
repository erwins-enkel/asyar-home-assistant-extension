<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { ExtensionContext } from 'asyar-sdk/view';
  import type { IActionService } from 'asyar-sdk/contracts';
  import { ActionContext } from 'asyar-sdk/contracts';
  import type { Entity, EntitiesReply } from '../lib/types';
  import { actionServiceFor } from '../lib/entities';
  import { iconFor, stateLabel, actionLabel } from '../lib/format';
  import { clampIndex, nextIndex, keyIntent, type KeyIntent } from '../lib/navigation';
  import SetupHint from '../components/SetupHint.svelte';

  let {
    context,
    actions,
    extensionId,
  }: { context: ExtensionContext; actions: IActionService; extensionId: string } = $props();

  let entities = $state<Entity[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let filter = $state('');
  let selectedIndex = $state(0);
  /** Entity ids with an in-flight service call, so rows can disable + spin.
   *  SvelteSet so mutation is tracked — a plain Set would need reassigning. */
  const pending = new SvelteSet<string>();
  let listEl = $state<HTMLElement | null>(null);
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  const MAX_ROWS = 300;

  async function load(force = false): Promise<void> {
    loading = true;
    error = null;
    try {
      // 30s, not the SDK's 5s default. The worker's cold path can legitimately
      // take ~25s: up to 10s for its own `preferences:getAll` (MessageBroker's
      // default) plus 15s for the HA fetch. A shorter view deadline would abort
      // work that was still progressing.
      const res = await context.request<EntitiesReply>(
        'getEntities',
        { force },
        {
          timeoutMs: 30_000,
        },
      );
      // Guard the shape, not just the error flag: an evicted worker replies
      // with nothing at all, and the derived list calls .map during render —
      // a non-array would take down the panel instead of showing a message.
      if (!res || !Array.isArray(res.entities)) {
        throw new Error('The Home Assistant background worker did not respond. Try again.');
      }
      entities = res.entities;
      if (!res.ok && res.error) error = res.error;
    } catch (err) {
      error = String((err as Error)?.message ?? err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  /** Sort key: things you can act on first, dead entities last. */
  function rank(e: Entity): number {
    if (e.state === 'unavailable' || e.state === 'unknown') return 2;
    return e.controllable ? 0 : 1;
  }

  const visible = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return (
      entities
        .filter(
          (e) => !q || e.name.toLowerCase().includes(q) || e.entityId.toLowerCase().includes(q),
        )
        // A real instance has thousands of entities, most of them unavailable
        // device trackers with machine-generated names. Without this the first
        // screenful is entirely junk.
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
        .slice(0, MAX_ROWS)
    );
  });

  // Keep the cursor inside the list when filtering shrinks it under the caret.
  $effect(() => {
    const len = visible.length;
    if (selectedIndex > len - 1) selectedIndex = clampIndex(selectedIndex, len);
  });

  async function revealSelected(): Promise<void> {
    await tick();
    listEl
      ?.querySelector<HTMLElement>(`[data-row-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  async function act(entity: Entity): Promise<void> {
    const service = actionServiceFor(entity.entityId, entity.state);
    if (!service || pending.has(entity.entityId)) return;

    pending.add(entity.entityId);
    try {
      const res = await context.request<{ ok: boolean; error?: string }>(
        'callService',
        { domain: entity.domain, service, entityId: entity.entityId },
        { timeoutMs: 30_000 },
      );

      if (!res?.ok) {
        error = res?.error ?? 'The service call failed.';
        return;
      }
      // HA applies the change asynchronously; a forced reload right away can
      // still read the old state, so re-read after a short beat. Tracked so
      // unmount can cancel it.
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void load(true), 400);
    } catch (err) {
      // Without this the rejection escapes as an unhandled rejection, and the
      // window-level handler in view.ts replaces the whole panel with a stack
      // dump — losing the list over one failed toggle.
      error = String((err as Error)?.message ?? err);
    } finally {
      pending.delete(entity.entityId);
    }
  }

  function activateSelected(): void {
    const entity = visible[selectedIndex];
    if (entity) void act(entity);
  }

  /** Routes an intent to an effect. Returns true when the view consumed it. */
  function dispatchIntent(intent: KeyIntent | null): boolean {
    if (!intent) return false;
    if (intent === 'refresh') {
      void load(true);
      return true;
    }
    if (intent === 'activate') {
      activateSelected();
      return true;
    }
    selectedIndex = nextIndex(visible.length, selectedIndex, intent);
    void revealSelected();
    return true;
  }

  // Keys reach the view from two mutually exclusive sources depending on where
  // focus sits: the host forwards them as `asyar:view:keydown` while the
  // launcher window has focus, and they fire natively inside the iframe once
  // focus is in here. Both drive the same reducer.
  function onHostMessage(event: MessageEvent): void {
    if (event.source !== window.parent) return;
    const data = event.data as
      | {
          type?: string;
          payload?: { query?: string; key?: string; metaKey?: boolean; ctrlKey?: boolean };
        }
      | undefined;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'asyar:view:search') {
      // With `searchable: true` the launcher's search bar is this panel's
      // input, so there is no second search box in here.
      filter = data.payload?.query ?? '';
      selectedIndex = 0;
      return;
    }
    if (data.type !== 'asyar:view:keydown') return;
    const p = data.payload ?? {};
    dispatchIntent(keyIntent({ key: p.key ?? '', meta: p.metaKey, ctrl: p.ctrlKey }));
  }

  function onLocalKeydown(e: KeyboardEvent): void {
    const handled = dispatchIntent(keyIntent({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey }));
    // Stop arrows from moving a text cursor and Enter from submitting.
    if (handled) e.preventDefault();
  }

  // Computed lazily rather than as module-level consts: reading a prop at the
  // top level captures only its initial value (svelte state_referenced_locally).
  const actionId = (name: string): string => `${extensionId}.view.${name}`;

  onMount(() => {
    window.addEventListener('message', onHostMessage);
    window.addEventListener('keydown', onLocalKeydown);

    // EXTENSION_VIEW actions surface in the launcher's ⌘K drawer while this
    // panel is mounted. `shortcut` here is a display label, not a binding —
    // the actual key handling is the reducer above.
    actions.registerAction({
      id: actionId('toggle'),
      title: 'Toggle Entity',
      icon: '💡',
      shortcut: '↵',
      category: 'Home Assistant',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => activateSelected(),
    });
    actions.registerAction({
      id: actionId('refresh'),
      title: 'Refresh Entities',
      icon: '🔄',
      category: 'Home Assistant',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => void load(true),
    });
  });

  onDestroy(() => {
    if (reloadTimer) clearTimeout(reloadTimer);
    window.removeEventListener('message', onHostMessage);
    window.removeEventListener('keydown', onLocalKeydown);
    actions.unregisterAction(actionId('toggle'));
    actions.unregisterAction(actionId('refresh'));
  });
</script>

<div class="ha">
  <header class="ha-head">
    <h1 class="ha-title">Home Assistant</h1>
    <span class="ha-count">
      {#if filter}
        {visible.length} of {entities.length}
      {:else}
        {entities.length} entities
      {/if}
    </span>
  </header>

  {#if error && entities.length === 0}
    <SetupHint {error} />
  {:else}
    {#if error}
      <p class="ha-error">{error}</p>
    {/if}

    {#if loading && entities.length === 0}
      <p class="ha-empty">Loading entities…</p>
    {:else if visible.length === 0}
      <p class="ha-empty">
        {filter ? `Nothing matches “${filter}”.` : 'No entities.'}
      </p>
    {:else}
      <ul class="ha-list" role="listbox" tabindex="-1" bind:this={listEl}>
        {#each visible as entity, i (entity.entityId)}
          {@const service = actionServiceFor(entity.entityId, entity.state)}
          {@const busy = pending.has(entity.entityId)}
          <li
            role="option"
            class="ha-row"
            class:ha-row-selected={i === selectedIndex}
            data-row-index={i}
            aria-selected={i === selectedIndex}
          >
            <span class="ha-icon" aria-hidden="true">{iconFor(entity.domain)}</span>
            <span class="ha-names">
              <span class="ha-name">{entity.name}</span>
              <span class="ha-id">{entity.entityId}</span>
            </span>
            <span class="ha-state" class:ha-state-on={entity.state === 'on'}>
              {stateLabel(entity)}
            </span>
            {#if service}
              <button
                class="ha-act"
                onclick={() => void act(entity)}
                onmouseenter={() => (selectedIndex = i)}
                onfocus={() => (selectedIndex = i)}
                disabled={busy}
              >
                {busy ? '…' : actionLabel(entity, service)}
              </button>
            {:else}
              <span class="ha-readonly">read-only</span>
            {/if}
          </li>
        {/each}
      </ul>
      {#if visible.length === MAX_ROWS}
        <p class="ha-empty">
          Showing the first {MAX_ROWS} matches — keep typing to narrow it down.
        </p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .ha {
    padding: var(--space-3);
    color: var(--text-primary);
  }
  .ha-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }
  .ha-title {
    margin: 0;
    font-size: var(--font-size-lg);
    font-weight: 600;
  }
  .ha-count {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }
  .ha-act {
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-primary);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-2);
    font-size: var(--font-size-xs);
    cursor: pointer;
    transition: background var(--transition-normal);
    flex: none;
  }
  .ha-act:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .ha-act:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ha-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .ha-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    border-bottom: 1px solid var(--separator);
    border-left: 2px solid transparent;
  }
  .ha-row-selected {
    background: var(--bg-selected, var(--bg-hover));
    border-left-color: var(--accent-primary, var(--text-primary));
  }
  .ha-icon {
    font-size: var(--font-size-lg);
    flex: none;
  }
  .ha-names {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .ha-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ha-id {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ha-state {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    flex: none;
  }
  .ha-state-on {
    color: var(--accent-success);
  }
  .ha-readonly {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    flex: none;
  }
  .ha-error {
    margin: 0 0 var(--space-2);
    color: var(--accent-danger);
    font-size: var(--font-size-sm);
  }
  .ha-empty {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    padding: var(--space-2);
  }
</style>
