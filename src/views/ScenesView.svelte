<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { ExtensionContext } from 'asyar-sdk/view';
  import type { IActionService } from 'asyar-sdk/contracts';
  import { ActionContext } from 'asyar-sdk/contracts';
  import type { Entity, EntitiesReply } from '../lib/types';
  import { iconFor } from '../lib/format';
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
  let fired = $state<string | null>(null);
  let pending = $state<string | null>(null);
  let listEl = $state<HTMLElement | null>(null);
  let firedTimer: ReturnType<typeof setTimeout> | null = null;

  async function load(force = false): Promise<void> {
    loading = true;
    error = null;
    try {
      // 30s, not the SDK's 5s default — see EntitiesView for the arithmetic.
      const res = await context.request<EntitiesReply>(
        'getEntities',
        { force },
        {
          timeoutMs: 30_000,
        },
      );
      // See EntitiesView: a non-array here would break rendering, not just data.
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

  const runnables = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return entities
      .filter((e) => e.domain === 'scene' || e.domain === 'script')
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.entityId.toLowerCase().includes(q))
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
  });

  // Keep the cursor inside the list when filtering shrinks it under the caret.
  $effect(() => {
    const len = runnables.length;
    if (selectedIndex > len - 1) selectedIndex = clampIndex(selectedIndex, len);
  });

  async function revealSelected(): Promise<void> {
    await tick();
    listEl
      ?.querySelector<HTMLElement>(`[data-row-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  async function run(entity: Entity): Promise<void> {
    if (pending) return;
    pending = entity.entityId;
    error = null;
    try {
      const res = await context.request<{ ok: boolean; error?: string }>(
        'callService',
        { domain: entity.domain, service: 'turn_on', entityId: entity.entityId },
        { timeoutMs: 30_000 },
      );

      if (!res?.ok) {
        error = res?.error ?? 'The service call failed.';
        return;
      }
      // Scenes and scripts have no lasting state to re-read, so confirm
      // inline and get out of the way rather than reloading the whole list.
      fired = entity.entityId;
      if (firedTimer) clearTimeout(firedTimer);
      firedTimer = setTimeout(() => {
        if (fired === entity.entityId) fired = null;
      }, 1500);
    } catch (err) {
      // An escaping rejection would reach view.ts's window handler, which
      // replaces the entire panel with a stack dump.
      error = String((err as Error)?.message ?? err);
    } finally {
      pending = null;
    }
  }

  function activateSelected(): void {
    const entity = runnables[selectedIndex];
    if (entity) void run(entity);
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
    selectedIndex = nextIndex(runnables.length, selectedIndex, intent);
    void revealSelected();
    return true;
  }

  // Keys arrive either forwarded by the host (launcher window focused) or
  // natively (focus inside the iframe). Both drive the same reducer.
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
    if (handled) e.preventDefault();
  }

  // Computed lazily rather than as module-level consts: reading a prop at the
  // top level captures only its initial value (svelte state_referenced_locally).
  const actionId = (name: string): string => `${extensionId}.scenes.${name}`;

  onMount(() => {
    window.addEventListener('message', onHostMessage);
    window.addEventListener('keydown', onLocalKeydown);

    actions.registerAction({
      id: actionId('run'),
      title: 'Activate Scene / Run Script',
      icon: '🎬',
      shortcut: '↵',
      category: 'Home Assistant',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => activateSelected(),
    });
    actions.registerAction({
      id: actionId('refresh'),
      title: 'Refresh Scenes',
      icon: '🔄',
      category: 'Home Assistant',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => void load(true),
    });
  });

  onDestroy(() => {
    if (firedTimer) clearTimeout(firedTimer);
    window.removeEventListener('message', onHostMessage);
    window.removeEventListener('keydown', onLocalKeydown);
    actions.unregisterAction(actionId('run'));
    actions.unregisterAction(actionId('refresh'));
  });
</script>

<div class="ha">
  <header class="ha-head">
    <h1 class="ha-title">Scenes &amp; Scripts</h1>
    <span class="ha-count">
      {#if filter}
        {runnables.length} match{runnables.length === 1 ? '' : 'es'}
      {:else}
        {runnables.length}
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
      <p class="ha-empty">Loading…</p>
    {:else if runnables.length === 0}
      <p class="ha-empty">
        {filter ? `Nothing matches “${filter}”.` : 'No scenes or scripts found.'}
      </p>
    {:else}
      <ul class="ha-list" role="listbox" tabindex="-1" bind:this={listEl}>
        {#each runnables as entity, i (entity.entityId)}
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
            <button
              class="ha-act"
              onclick={() => void run(entity)}
              onmouseenter={() => (selectedIndex = i)}
              onfocus={() => (selectedIndex = i)}
              disabled={pending === entity.entityId}
            >
              {#if fired === entity.entityId}
                Done
              {:else if pending === entity.entityId}
                …
              {:else}
                {entity.domain === 'scene' ? 'Activate' : 'Run'}
              {/if}
            </button>
          </li>
        {/each}
      </ul>
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
    font-family: var(--font-mono, ui-monospace, 'SF Mono', Consolas, monospace);
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
