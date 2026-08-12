<script lang="ts">
  // Shown when the extension has no URL/token yet, or when Home Assistant
  // rejected what we have. Both cases end at the same place — the preferences
  // panel — so one component covers them, with the specific error passed in.
  let { error = null }: { error?: string | null } = $props();
</script>

<div class="ha-hint">
  <p class="ha-hint-title">
    {error ? 'Home Assistant could not be reached' : 'Connect to Home Assistant'}
  </p>

  {#if error}
    <p class="ha-hint-error">{error}</p>
  {/if}

  <ol class="ha-hint-steps">
    <li>
      In Home Assistant, open your profile → <strong>Security</strong> →
      <strong>Long-lived access tokens</strong> → <strong>Create token</strong>.
    </li>
    <li>
      Paste the URL and token in
      <strong>Settings → Extensions → Home Assistant</strong>.
    </li>
  </ol>

  <p class="ha-hint-note">
    The token is encrypted on this device and is never synced between machines, so it has to be
    entered once per computer.
  </p>
</div>

<style>
  .ha-hint {
    margin-top: var(--space-3);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    line-height: 1.5;
    max-width: 520px;
  }
  .ha-hint-title {
    margin: 0 0 var(--space-2);
    color: var(--text-primary);
    font-weight: 600;
  }
  .ha-hint-error {
    margin: 0 0 var(--space-2);
    color: var(--accent-danger);
  }
  .ha-hint-steps {
    margin: 0 0 var(--space-2);
    padding-left: 1.25em;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .ha-hint-note {
    margin: 0;
    font-size: var(--font-size-xs);
  }
</style>
