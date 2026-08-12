import { mount } from 'svelte';
import { ExtensionContext, registerIconElement } from 'asyar-sdk/view';
import type { IActionService, ILogService } from 'asyar-sdk/contracts';
import EntitiesView from './views/EntitiesView.svelte';
import ScenesView from './views/ScenesView.svelte';

// Surface uncaught errors in the panel itself — an extension iframe has no
// visible console, so without this a failure is an inexplicably blank panel.
function showFatal(label: string, detail: string): void {
  const el = document.getElementById('app');
  if (!el) return;
  const pre = document.createElement('pre');
  pre.style.cssText =
    'white-space:pre-wrap;word-break:break-word;padding:16px;margin:0;' +
    'color:#ff6b6b;font:12px/1.5 ui-monospace,monospace';
  pre.textContent = `[Home Assistant ${label}]\n${detail}`; // textContent — no HTML injection
  el.replaceChildren(pre);
}
// WebKit's `error.stack` carries only frames, not the message, so print both
// or the panel shows a stack trace with no indication of what actually failed.
function describe(err: unknown, fallback = ''): string {
  const e = err as { name?: string; message?: string; stack?: string } | undefined;
  const message = e?.message || fallback || String(err);
  // Svelte's production build throws errors whose detail lives in non-enumerable
  // props, so dump every own property rather than trusting `message` alone.
  let own = '';
  try {
    if (err && typeof err === 'object') {
      own = JSON.stringify(err, Object.getOwnPropertyNames(err), 2);
    }
  } catch {
    /* circular or exotic — the message and stack still get through */
  }
  const stack = e?.stack ? `\n\n${e.stack}` : '';
  return `${e?.name ?? 'Error'}: ${message}\n${own}${stack}`;
}
// One pair of handlers, reporting to both surfaces. The SDK installs its own
// error listeners too, so registering a second pair here would double-report
// every fault to the host's feedback service.
function onFatal(label: string, detail: string): void {
  report(label, detail);
  showFatal(label, detail);
}
window.addEventListener('error', (e: ErrorEvent) => {
  onFatal('error', describe(e.error, `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
});
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  onFatal('unhandledrejection', describe(e.reason, String(e.reason)));
});

const extensionId = resolveExtensionId();
const context = new ExtensionContext();
context.setExtensionId(extensionId);
registerIconElement();

// No manual `asyar:extension:loaded` post — ExtensionContextCore.setExtensionId
// already emits it with the resolved role. Posting again triggers a second
// readiness ack and a duplicate preference push.

const log = context.getService<ILogService>('log');
const actions = context.getService<IActionService>('actions');

// The panel reporter above is for the user; this puts the same detail in the
// host log, which is the only way to read an iframe failure without devtools.
function report(label: string, detail: string): void {
  try {
    // Not optional-chained: getService throws rather than returning undefined,
    // and ILogService.error is required. The try/catch is still needed because
    // a fault during module evaluation reaches here before `log` is assigned.
    log.error(`[home-assistant/${label}] ${detail}`);
  } catch {
    /* logging must never mask the original failure */
  }
}
/**
 * Native form controls — notably a `<select>` popup — are painted by the
 * platform, not by our stylesheet, so they ignore the host's injected theme
 * tokens and render as light-on-light inside a dark theme. `color-scheme` is
 * the only property that reaches them. The design tokens carry no light/dark
 * flag, so derive it from the luminance of the injected background.
 */
function syncColorScheme(): void {
  // Custom properties come back as the literal author string — the host writes
  // theme values verbatim into a <style> block, so `--bg-primary` could be
  // `#f5f5f5`, `hsl(...)`, or a colour name, none of which a digit-scraping
  // regex reads correctly (`#f5f5f5` would scan as 5,5,5 → "dark" on a light
  // theme). Assign it to a real property on a throwaway element instead and
  // read back the computed value, which the engine normalises to rgb().
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  probe.style.color = 'var(--bg-primary, var(--bg-secondary, #1e1e20))';
  document.body?.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  const channels = resolved.match(/\d+(?:\.\d+)?/g);
  if (!channels || channels.length < 3) return;
  const [r, g, b] = channels.slice(0, 3).map(Number);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const scheme = luminance < 0.5 ? 'dark' : 'light';
  document.documentElement.style.colorScheme = scheme;
  if (document.body) document.body.style.colorScheme = scheme;
}

syncColorScheme();
// The SDK's theme injector appends a <style id="asyar-theme-vars"> and *then*
// writes its textContent, and rewrites that text on every theme change. Watch
// character data and the subtree, not just childList, or the probe runs against
// an empty rule and never sets a scheme at all.
new MutationObserver(syncColorScheme).observe(document.head, {
  childList: true,
  subtree: true,
  characterData: true,
});

const viewName = new URLSearchParams(window.location.search).get('view') || 'EntitiesView';
const target = document.getElementById('app')!;

// Services are resolved here rather than inside components. Not enforced by
// the SDK — getService is a plain lookup — but it is the documented convention
// (docs/how-to/best-practices.md) and keeps components free of host coupling.
const views: Record<string, typeof EntitiesView> = { EntitiesView, ScenesView };
try {
  mount(views[viewName] ?? EntitiesView, {
    target,
    props: { context, actions, extensionId },
  });
} catch (err) {
  onFatal('mount', describe(err));
}

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
