# Home Assistant

Control your smart home from [Asyar](https://asyar.org) — type an entity name into the
launcher and hit Enter to toggle it, browse and filter everything, activate scenes, and
let Asyar's AI agents read state and call services.

## Quick control from the search bar

With the launcher open, start typing:

```
kitchen
  💡  Kitchen Ceiling          Light · On · Turn off
  💡  Kitchen Counter          Light · Off · Turn on
  🎬  Kitchen Evening          Scene · Activate scene
```

Enter acts on the highlighted result. Which domains appear here is configurable — by
default lights, switches, scenes, scripts, input booleans, fans, covers, and media
players, so sensors don't crowd out your apps and files.

## Commands

| Command                     | What it does                                        |
| --------------------------- | --------------------------------------------------- |
| **Home Assistant Entities** | Every entity, filtered by the launcher's search bar |
| **Home Assistant Scenes**   | Scenes and scripts, one keystroke to fire           |

Both panels use the launcher's own search bar rather than their own input. Arrows move
the selection, Enter acts, Home/End jump to the ends, and ⌘K lists the panel's actions.
Entities you can act on sort above read-only ones, and unavailable entities sink to the
bottom — on a large instance the first screenful is otherwise all dead device trackers.

## AI tools

The extension registers three tools, so you can ask in plain language:

| Tool               | Use                                                  |
| ------------------ | ---------------------------------------------------- |
| `ha-list-entities` | _"which lights are on?"_, _"what's in the kitchen?"_ |
| `ha-get-state`     | _"how warm is the office?"_                          |
| `ha-call-service`  | _"turn the hallway light off"_                       |

`ha-call-service` rejects a domain/entity mismatch (e.g. `light.turn_on` aimed at a
`switch.*` entity). Home Assistant would answer 200 and silently do nothing, which is
the worst possible outcome for an agent acting on your behalf.

## Setup — URL and token (required)

1. In Home Assistant, open your profile → **Security** → **Long-lived access tokens** →
   **Create token**.
2. In Asyar, open **Settings → Extensions → Home Assistant** and fill in:

| Preference                   | Notes                                                                      |
| ---------------------------- | -------------------------------------------------------------------------- |
| **Home Assistant URL**       | Base URL. A bare host, a trailing `/`, or a trailing `/api` all work.      |
| **Long-lived access token**  | Encrypted on this device, and excluded from cloud sync.                    |
| **Domains in global search** | Comma-separated. Narrow it to keep the root search bar uncluttered.        |
| **Minimum characters**       | Below this the extension contributes nothing to global search (default 3). |

Because tokens are excluded from sync by design, you enter one **per machine**. Rotating
a token takes effect without restarting the launcher — a rejected request forces a
credential re-read.

## How it stays fast

A launcher keystroke can't wait on an HTTP round-trip, so global search never touches
the network. It reads a 60-second cache kept warm by a background refresh (every 300s)
and by opening either panel. A cold cache contributes nothing for that keystroke rather
than stalling the search bar.

If the instance is unreachable, a 30-second backoff suppresses speculative retries —
otherwise typing "kitchen light" would fire one request per character.

Enter sends an explicit `turn_on`/`turn_off` rather than `toggle`. If Home Assistant's
reported state is stale, `toggle` drives the device the wrong way, while an explicit
call is idempotent in the direction you actually asked for.

## Development

```bash
pnpm install
pnpm test:run      # unit tests
pnpm check         # svelte-check
pnpm lint          # eslint
pnpm build         # build dist/
asyar attach       # register with the launcher, then restart it
```

`asyar attach` (not `asyar link`) is what you want for local development: the launcher's
asset server canonicalises symlinks and refuses paths outside its allowed roots, so a
linked extension outside the app data directory serves 403s. `attach` records the real
path in the dev registry, which is the allowlist that check consults.

The HTTP layer is confined to `src/lib/api.ts` (request builders and parsing), so the
rest of the code never sees a URL. `src/lib/configGate.ts` holds the credential
state machine as an injectable factory — the worker module can't be imported by tests,
because the SDK asserts `window.__ASYAR_ROLE__` at load, so anything stateful worth
testing lives in `src/lib/` instead.

## Known limitations

- **Polling, not push.** The SDK's `NetworkService` is request/response only, so there's
  no subscription to Home Assistant's WebSocket event stream. State is up to 60s stale.
- **One instance.** Multiple Home Assistant servers would need instance tagging
  throughout the entity list and search results.
- **Setup hint is broad.** Any failure with an empty entity list shows the token advice,
  including transport failures that have nothing to do with the token.
