# Understanding Zen MCP — a reimplementation-oriented study

> This is a **behavioral/architectural analysis**, written in my own words, of the
> upstream project at `https://github.com/spaxe-dev/zen-mcp` (v0.6.0, commit
> `ba3cf13`). Its purpose is to understand *what the system does and why* so we
> can design and build our own version. It deliberately avoids reproducing the
> upstream source; where implementation detail matters, it is described as an
> algorithm/contract, not pasted.

---

## 1. What the project is, in one paragraph

Zen MCP is a **Model Context Protocol (MCP) server** that gives an AI agent
controlled access to a **real Zen Browser window** (Zen is a Firefox fork). It
launches *its own* Zen process with a debug port (Marionette) enabled, proves
that the browser answering on that port is the one it started, then locks the
port down so nobody else can attach. It injects a small **bridge** into the
browser's privileged "chrome" scope; the bridge connects back to the server over
an authenticated loopback WebSocket and exposes a fixed set of operations that
use Zen's own internal APIs (spaces, folders, tabs, essentials, split view,
Glance). On top of that bridge sits an MCP surface of 55 tools, 6 resources and
3 prompts, with a policy layer (consent, Pause, read-only, domain allowlist,
audit log). Reads happen **in the background** through the browser's content
actor, so the agent can research twenty tabs without disturbing what the human
is looking at. A special "Evidence Mode" can highlight a cited passage in the
actual page so a user can verify an answer.

---

## 2. Big-picture architecture

```
MCP client (Claude Code, Cursor, OpenCode, ...)
        │  JSON-RPC over stdio
        ▼
┌───────────────────────────────────────────────────────────────┐
│ Node server (src/cli.ts → src/mcp/server.ts)                   │
│                                                                │
│  MCP surface          policy/guard          ZenRuntime         │
│  - 55 tools           - read-only           (orchestrator)     │
│  - 6 resources        - allowlist           - owns lifecycle   │
│  - 3 prompts          - audit JSONL         - watches/events   │
│  - discovery          - pause/consent       - asks/questions   │
│                                                                │
│  BridgeHub (WebSocket server, HMAC auth, request router)       │
└───────────┬──────────────────────────────────┬─────────────────┘
            │ Marionette protocol              │ authenticated WS
            │ 127.0.0.1:2828 (raw TCP)         │ 127.0.0.1:<random>
            │ chrome-scope fixed scripts       │ loopback, token
            ▼                                  ▼
┌───────────────────────────┐        ┌──────────────────────────────┐
│ Zen Browser chrome scope  │◀──────▶│ Injected bridge (each normal  │
│ - launch nonce via env    │ inject │ window, system principal)     │
│ - lockdown (close port)   │        │ - fixed method map (ops.ts)   │
│ - content actor reads     │        │ - UI cards in shadow root     │
└───────────────────────────┘        │ - browser event observers     │
                                     └──────────────┬───────────────┘
                                                    ▼
                                          gZenWorkspaces, gZenFolders,
                                          gBrowser, Places, page content
```

Three layers, as the upstream docs describe:

1. **Launch/control plane** — spawns and owns the browser, proves identity,
   locks Marionette, injects the bridge, handles shutdown.
2. **Browser bridge** — runs inside Zen chrome, maps server requests onto Zen
   internal APIs, renders UI cards, watches browser events, authenticates both
   sides.
3. **MCP surface** — validates tool input, applies policy, calls the bridge,
   shapes typed results, exposes resources/prompts.

Design goals that explain most decisions:
- **Owned browser, never attached.** No "connect to your existing browser".
- **Native Zen constructs.** Use Zen's JS APIs rather than simulate clicks in UI.
- **Background first.** Reads/wait/search do not change selection/focus/scroll.
- **User in control.** One-time consent, global Pause, read-only, allowlist, audit.
- **Evidence over prose.** Citations are checked in the browser and highlighted.
- **Page content is data, never instructions.** No tool evaluates agent JS.

---

## 3. Source map — what each module is responsible for

| Path | Role |
|---|---|
| `src/cli.ts` | commander CLI: `serve`, `launch`, `status`, `doctor`, `setup`, `onboard`, `config show/set`, `update`; wires stdin/stdout stdio transport; SIGINT/SIGTERM shutdown. |
| `src/config.ts` | config schema, defaults, path resolution (`ZEN_MCP_CONFIG`, XDG/APPDATA), env overrides, bounded ints, strict boolean parsing, atomic save. |
| `src/shared/protocol.ts` | the single source of truth for all request/response types, the `BridgeMethodMap`, event/UI/session/evidence shapes. ~1500 lines of types. |
| `src/shared/brand.ts` | `BRAND`, `SERVER_VERSION`, `BRIDGE_PROTOCOL_VERSION`. |
| `src/shared/bridge-auth.ts` | auth labels (`zen-mcp-client-auth-v1:`, `zen-mcp-server-auth-v1:`), nonce size (32), timeouts, close codes. |
| `src/shared/url-policy.ts` | `normalizeWebUrl`, domain normalization, `isUrlAllowed` (exact host or subdomain on label boundary). |
| `src/shared/errors.ts` | maps error codes to `{category, retryable, stateChanged, recovery}`. |
| `src/shared/read-script.ts` | the big in-browser read engine (text/markdown/links/tables/metadata/outline/interactive/snapshot/semantic), frame traversal, sensitivity, target resolution. |
| `src/shared/evidence-script.ts` | quote matching (exact→normalized→context→fuzzy) and overlay painting. |
| `src/shared/semantic.ts`, `snapshot.ts`, `search.ts`, `target.ts`, `delta.ts`, `sensitive.ts`, `frame-path.ts`, `evidence.ts` | helpers shared between server and injected scripts. |
| `src/zen/launcher.ts` | find Zen executable per OS, build launch args (`-marionette -no-remote -profile …`), spawn detached with nonce env, profile-lock checks, process kill. |
| `src/zen/marionette.ts` | minimal Marionette v3 TCP client: length-prefixed JSON frames, command correlation, chrome/content contexts, script wrapping, nonce read, **lockdown**, quit. |
| `src/zen/runtime.ts` | central orchestrator: lazy connect, launch+verify+lockdown, consent, bridge injection/auto-attach, all high-level tool operations, watches, evidence batching, shutdown. |
| `src/zen/page.ts` | helpers to run a read through Marionette content actor (`readTabPage`, `readActivePage`). |
| `src/zen/sessions.ts`, `templates.ts` | persisted window snapshots and space templates with caps, sanitization, atomic private writes. |
| `src/zen/doctor.ts`, `updates.ts`, `tab-audit.ts` | diagnostics, npm update check/banner, duplicate/stale/domain tab heuristics. |
| `src/bridge/host.ts` | `BridgeHub`: WebSocket server on loopback, HMAC handshake, connection registry, request routing, consent/Pause enforcement, event log, questions, injection script builder. |
| `src/bridge/entry.ts` | browser bundle bootstrap: config handoff, HMAC proof, reconnect, message dispatch to ops/UI, Stop retry. |
| `src/bridge/ops.ts` | the fixed method map implementation over Zen internals (spaces, tabs, folders, reads, clicks, evidence, history, etc.). |
| `src/bridge/ui.ts` | shadow-root cards: consent, progress+Stop, questions, notifications, banner with Pause/Update. |
| `src/bridge/browser-events.ts`, `event-log.ts`, `ref-registry.ts`, `tab-activation.ts`, `essentials-state.ts`, `evidence-reveal.ts`, `pending-stop.ts`, `split-cleanup.ts`, `tab-identity.ts` | bridge helpers. |
| `src/mcp/server.ts` | builds the MCP server, registers all 55 tools + 6 resources + 3 prompts, the `guarded()` wrapper, discovery tools, surface filtering. |
| `src/mcp/catalog.ts`, `descriptions.ts`, `output-schemas.ts`, `guard.ts`, `progress.ts` | tool metadata & surfaces, tool descriptions, zod output schemas, policy/audit, progress notifications. |
| `src/onboard/clients.ts`, `picker.ts`, `theme.ts` | merge config into 28+ MCP clients, interactive picker, terminal theme. |
| `scripts/build.mjs` | esbuild: bundle CLI for node (external deps) and bridge for Firefox 128 IIFE; chmod +x. |
| `scripts/*.mjs`, `test/` | test runner, context budget, agent eval, benchmarks, unit + integration tests. |

---

## 4. Layer 1 — Launch and control plane

### 4.1 Configuration (`config.ts`)
- Config file: `%APPDATA%\zen-mcp\config.json` on Windows; `$XDG_CONFIG_HOME/zen-mcp/config.json` or `~/.config/zen-mcp/config.json` elsewhere; `ZEN_MCP_CONFIG` overrides.
- Data dir: `ZEN_MCP_DATA_DIR` → `dataDir` → `<config dir>/data`.
- Defaults: dedicated agent profile, consent on (90 s), autoLaunch on, launchTimeout 45 s, askTimeout 120 s, port 2828, readOnly off, allowlist empty, audit on, autoAttachWindows on, watchMinInterval 15 s, toolSurface `research`.
- Env vars override file values; booleans accept `1/0 true/false yes/no on/off` and **throw on anything else** (fail closed). Policy fields in the file must be real JSON booleans/string arrays — a malformed value stops startup rather than silently weakening policy. Numeric file values are clamped; `config set` rejects out-of-range. `saveConfig` reads the raw file so env overrides are never baked in.

### 4.2 CLI (`cli.ts`)
`serve` is the default action and the real server entry: load config → `new ZenRuntime({config})` → `createZenMcpServer(runtime, config)` → `StdioServerTransport` → `server.connect`. It installs SIGINT/SIGTERM and `transport.onclose` handlers that call `runtime.shutdown()` then `process.exit(0)`. Logs go to **stderr** (stdout is the MCP wire).
Other commands are one-shot diagnostics against the same runtime (`launch` starts a browser, verifies ownership, prints info, quits; `status`/`doctor` inspect config/port/profile; `setup` writes config; `onboard` edits client configs; `config set/show`; `update` checks npm and runs a global install).

### 4.3 Launcher (`launcher.ts`)
- Executable detection per OS: Windows Program Files / LOCALAPPDATA paths; macOS `/Applications/Zen Browser.app/.../zen`; Linux `/usr/bin/zen`, Flatpak, Snap candidates.
- Launch args: `-marionette`, `-no-remote`, and `-profile <dir>` for a dedicated profile; extra user args appended.
- Profile resolution: custom `profilePath` → else normal profile if `useDefaultProfile` → else `<dataDir>/agent-profile`.
- Refuses to launch if the Marionette port is already open (someone else owns it), and for the normal profile if any Zen process is running.
- Spawns **detached**, stdio ignored, with child-only env: `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, `ZEN_MCP_LAUNCHED=1`, `ZEN_MCP_LAUNCH_NONCE=<uuid>`. No Zen preference is modified, so a normal Zen launch never opens a debug port.
- Process checks: Windows `tasklist`/`taskkill /T /F`; POSIX `pgrep -x` over several Zen process names, `kill(pid,0)`, and `kill(-pid, SIGKILL)` for the process group. Profile lock: Windows exclusive lock on `parent.lock`; POSIX `.parentlock`/`lock`/`parent.lock` symlinks whose target ends in a PID — a stale lock whose PID is dead counts as free.

### 4.4 Marionette client (`marionette.ts`)
A hand-written, dependency-free client for Firefox's Marionette **v3** protocol over a raw TCP socket:
- **Framing**: outbound `{byteLength}:{JSON}`. Inbound is parsed by scanning for a colon, validating the numeric header, enforcing a 256 MB frame cap, then JSON-parsing the body. A bad header destroys the socket.
- **Handshake**: the browser first sends an object with `applicationType` / `marionetteProtocol`; the client resolves a pending handshake promise.
- **Session**: `WebDriver:NewSession` → `WebDriver:SetTimeouts` → `Marionette:SetContext {value:"chrome"}`. Session id and capabilities (`moz:processID`, `moz:profile`) are retained.
- **Commands**: length-framed JSON arrays `[0, id, name, params]`; responses are `[1, id, error, result]` correlated through a pending map with timeouts.
- **Scripts**: a wrapper turns a script body into an async IIFE that always calls the WebDriver async callback with `{__zenMcpOk, value}` or `{__zenMcpOk:false, error}`, preserving name/message/stack because Gecko stacks are otherwise frame-only. All reads/chrome scripts use `WebDriver:ExecuteAsyncScript`.
- **Contexts**: `executeChrome` sets chrome context; `executeInContent(handle, …)` temporarily switches to content, switches to a window with `focus:false` (so reads never select/take focus), runs the script, restores chrome; all content calls are serialized through a promise queue because context is global session state.
- **Ownership proof**: in chrome scope, read `ZEN_MCP_LAUNCH_NONCE` through `Services.env` (falling back to `Cc["@mozilla.org/process/environment;1"]`) and compare it with the spawned nonce. Only on a match does it record `moz:processID` as the browser PID.
- **Lockdown**: import `chrome://remote/content/components/Marionette.sys.mjs`, find `Marionette.server`, verify exactly one connection owns our session, close every other connection, then `server.setAcceptConnections(false)`. Fails the whole startup if competing sessions exist or the listener cannot close.
- **Quit**: `Marionette:Quit` with `eAttemptQuit` then `eForceQuit`; treat a socket close before the reply as normal and verify via PID.

### 4.5 Runtime (`runtime.ts`) — the orchestrator
- `connect()` is memoized in a single promise. It starts the Hub; if Marionette is disconnected and there is no ownership, it refuses if the port is open, refuses if `allowLaunch=false` (read-only), otherwise launches + verifies + locks down; then injects the bridge, waits for a connection, ensures consent, starts the auto-attach timer.
- If the Marionette session is lost after ownership+lockdown, it refuses to re-attach (port stays closed) and tells the caller to quit Zen and call `zen_launch`.
- **High-level operations** wrap `hub.request(method, params)` with `connect()`, URL checks, batching and result shaping: `status`, `ask`, `notify`, `progress`, `events`, `readPage`, `readPages` (10 tabs, 3 workers), `clickElement`, `typeText`, `waitFor`, `findText`, `searchTabs` (≤30 tabs, 2 workers, 200 match cap), `showEvidence`, `showEvidenceBatch` (≤20 citations, ≤5 quotes/source, concurrency 2–3, one tab per source URL, reuses existing tabs), `clearEvidence`, watches (≤50, interval clamped to config minimum, 120 min default expiry).
- **Evidence flow**: normalize URL to http(s), check allowlist; reuse an explicitly supplied tab only if its URL still matches, else find a tab by URL (prefer active), else open in background; optionally bring to front and *verify* it actually became active; call the bridge's `tabs.evidence`; show an activity card with a "Show source" action; remember marked tabs (bounded to 20) for `clearEvidence`.
- **Watch flow**: a baseline page read hashes page text; on each interval it re-reads and compares hashes/selector presence; "change" optionally requires a `contains` phrase; fires a `watch` event and optional card; stops on expiry, off-list URL, or tab loss.
- **Shutdown**: stop watches and Hub, send `shutdown` to bridges, close WS server, then graceful Marionette quit → forced quit → terminate only the recorded PID.

---

## 5. Layer 2 — Bridge host (`host.ts`, server side)

### 5.1 The Hub
- Opens a `ws` server on `127.0.0.1`, ephemeral port, path `/bridge`, no compression, 2 MB max payload. The browser **connects out**; it never listens.
- Per-session 256-bit token (`randomBytes(32)`) is shared only through the injection script.
- State: connection map keyed by `windowId`, pending request map, pending/answered questions, event log, progress card, stop state, paused/access/consent/banner, primary window id, robots.

### 5.2 Mutual authentication (per connection, including reconnects)
1. Reject non-loopback remote addresses.
2. Server generates a fresh 32-byte nonce and sends `auth.challenge`.
3. Bridge replies `auth.response {nonce: clientNonce, proof: HMAC(key, "zen-mcp-client-auth-v1:"+serverNonce)}`. Server verifies with `timingSafeEqual`.
4. Server sends `auth.confirm {nonce: clientNonce, proof: HMAC(key, "zen-mcp-server-auth-v1:"+clientNonce)}` — a *different label*, so a proof cannot be replayed in the other direction. Bridge verifies.
5. Only then `hello {protocol, bridgeVersion, windowId, focused, appVersion, platform}`; protocol and version must match; duplicate window ids replace the old connection; server sends `welcome`, restores banner/questions/progress/consent state.
- Only `auth.response` is accepted before authentication; only `hello` after. 10 s handshake timeout, distinct close codes for auth fail/timeout/required/protocol/version mismatch.
- Heartbeat ping/pong every 20 s; unresponsive connections are terminated.

### 5.3 Request routing
`request(method, params, {windowId, timeoutMs, signal})`: asserts consent+not-paused, checks cancellation, picks the connection, assigns an id, stores a pending entry (timeout 25 s default), sends `{type:"req", id, method, params}`, and resolves/rejects on the matching `res`, on timeout, on cancellation (AbortSignal), or on disconnect. In-flight requests are rejected on Pause or shutdown. Responses from the wrong window are ignored.

### 5.4 Consent and Pause
- Consent: `#assertActive()` throws `consent_required` unless granted, and `paused` when paused — enforced **at the hub request boundary**, not only in MCP tools. `requestConsent` broadcasts a card and resolves on click/deny/timeout; a timeout leaves the card open so a later call can wait again. Denial closes the owned browser.
- Pause: rejects all pending requests with `paused`, clears progress/stop, defers pending questions (sends `ui.cancel`, resolves them `deferred`), sets the paused banner, pushes a `pause` event; `resume` reverses it. While paused only a whitelist of local MCP tools/resources stay available, and the event stream serves only control events.

### 5.5 Events, questions, injection, shutdown
- `EventLog`: bounded (200) monotonic-id event stream; browser observations expire after 10 min, dedup within 2 s; `events({after, waitSeconds})` long-polls (≤25 s) and reports `cursor`, `missed`, `oldestCursor`, `dropped`, `filtered`, `stopped`, `paused`. Off-list navigation/document events are dropped and counted.
- Questions: `ask()` broadcasts `ui.ask`, waits up to config timeout, handles answered/deferred/unavailable, keeps an inbox.
- Injection: `buildInjectionScript` embeds `{url, token, versions}` into a chrome script that enumerates `Services.wm` browser windows, skips private windows, loads `bridge.js` from disk into a resource alias, and either starts a fresh bridge or signals an existing one to reconnect. `ensureInjected` retries until a connection appears.
- `stop()` cleans up every waiter, tells bridges to shut down, closes the WS server, resets all state.

---

## 6. Layer 3 — The injected bridge (browser side)

### 6.1 Bootstrap (`entry.ts`)
The IIFE reads `window.__zenMcpConfig` (URL + token + versions) and deletes it; destroys any previous bridge; refuses private windows (checks `privatebrowsingmode`); assigns a stable `win-xxxxxxxx` id. It installs the UI, an ops dispatcher, browser-event observers, and an evidence-record store (so "Show source" can replay the last highlight request for a tab). It connects out with exponential backoff (400 ms → 15 s), performs the HMAC handshake (WebCrypto `subtle.importKey`/`sign`, base64url, constant-time compare), sends `hello`, and dispatches incoming messages. A Stop press that happens while disconnected or unauthenticated is queued and retried once the socket is usable. Focus/blur messages keep the server's primary-window choice current.

### 6.2 Fixed method map (`ops.ts`)
The bridge accepts only named methods (`status`, `spaces.*`, `tabs.*`, `folders.*`, `essentials.*`, `containers.*`, `glance.*`, `split.*`, `history.*`, `bookmarks.*`, `clipboard.*`). There is **no tool that evaluates agent-supplied JavaScript**. All DOM work is done by fixed scripts assembled on the server; agent input is only structured arguments.

### 6.3 Zen internals used
Spaces/folders via `gZenWorkspaces` / `gZenFolders`; tab and window state via `gBrowser`; history/bookmarks via `Places`; UI cards via DOM in browser chrome; content reads via the Marionette content actor. This gives native-feeling behavior but couples the project tightly to Zen internals — a future Zen change fails loudly rather than silently doing the wrong thing.

### 6.4 UI cards (`ui.ts`)
Rendered into a **shadow root in browser chrome** (page scripts cannot reach them): a compact persistent banner with Pause/Resume and update controls; a consent card; a progress card with a real Stop button; question cards with options/freeform/multi-select; and activity/notification cards with actions such as "open space" or "Show source". Card actions send small typed messages back to the server (the "Show source" action carries only a tab id).

### 6.5 Tab identity and refs
- Server-side tab ids are assigned/mapped by the bridge and maintained across tab opens/closes; evidence and interactions use them.
- Interactive/snapshot/semantic reads assign short refs (`e12`, frame refs like `f0-e3`), which are **Marionette WebElement handles held server-side** — reads never write attributes into the page. A new read of the same document replaces that document's refs; a stale/navigated node returns `element_not_found`/`stale_reference`.
- Target resolution is strict: exactly one strategy (`ref`, `role`+`name`, `text`, `label`, `placeholder`, `selector`); two matches → `target_ambiguous` with up to five candidates; scan limits (≈6000 nodes, six matches) refuse rather than guess.

---

## 7. Layer 4 — MCP surface (`mcp/*`)

### 7.1 Tool surfaces and discovery
- 55 tools grouped by category. Three nested surfaces: **research** (17, default), **core** (38 = research + interaction/layout/folders/etc.), **full** (55). Surfaces only change `tools/list`, never the gateway.
- Tools outside the active surface are held in a `hiddenTools` map. `zen_tools_search` does keyword scoring over name/summary/category/aliases (name matches outrank body matches). `zen_tools_use` validates arguments against the hidden tool's schema and runs the *real handler*, so policy/audit still apply; `publish:true` adds it back to `tools/list` and sends `tools/list_changed`. `zen://capabilities` lists every tool/prompt/resource with counts. `validateCatalog()` asserts descriptions/categories/surfaces are consistent and fails startup on drift (e.g. research size enforced 16–19).
- The SDK's generated schemas are "compacted" for `tools/list` only (drop `$schema` and empty `additionalProperties`) to reduce token cost; validation still uses the full zod schemas.

### 7.2 The `guarded()` wrapper — central policy
Every tool handler runs through one wrapper:
1. If the client cancelled → audit `{ok:false, executed:false}`, return cancellation error.
2. If paused and the tool is not in `PAUSED_ALLOWED` (`zen_events`, `zen_answers`, `zen_config`, `zen_audit_tail`) → `paused` error.
3. Gather URLs (from args plus extra sources like sessions/templates), then `guard.check`: read-only blocks the 32 mutating tools; allowlist checks each normalized http(s) URL (missing scheme → `https://`; non-http(s) → blocked).
4. Run the handler with the AbortSignal, audit the outcome, send `notifications/resources/list_changed` for resource-changing tools, return `{content:[{type:text,…}], structuredContent: value}`.
5. On error: audit, send a sanitized `notifications/message` (URLs replaced with `[redacted-url]`, no args/page text), return `isError:true`. Only `zen_click`/`zen_type` include a structured error object (their output schemas model an error variant).

### 7.3 Read formats and interaction (contracts)
- `zen_read_page` formats: `text`, `markdown`, `links`, `tables`, `metadata`, `outline`, `interactive`, `snapshot`, `semantic`; optional `selector`; paged `text`/`markdown` via `offset`/`nextOffset` (24k default, 60k max chars). Structured list formats ignore offset and say so in `limitation`.
- `framePath` (e.g. `[0]`, `[0,1]`, max depth 3, ≤20 frames listed) drills into iframes; off-list/non-http(s) frames are never listed/read.
- `snapshot` is the bounded "what can I act on" view: 4k text preview, ≤100 controls (200 with `maxElements`), ≤80 headings; controls carry refs and state flags but **no values or value lengths**; completeness flags separate collection from output caps.
- `semantic` returns landmarks, heading hierarchy, repeated collections, dialogs, coverage and a confidence-labelled classification (article/search-results/product/listing/dashboard/login/form/documentation/discussion/generic); no field values, no hidden/`aria-hidden` text; label source (aria/html/heading/inferred) is reported.
- `zen_click`/`zen_type`: one target strategy; strict resolution; `zen_type` appends unless `clear:true`, caps 10k chars, refuses sensitive/file/disabled/read-only targets, reports only a character count and an internal `observed` comparison (never the value). Both return an `effect` computed from before/after signatures (URL/title/text/element/form-value hashes, counts) with `attribution: "observed_after_action_not_proven"` and a bounded `delta`.
- `zen_wait_for`: exactly one of selector/text/urlContains/titleContains/document/documentChanged/newTab/tabClosed/dialog, `until: present|absent`, timeout 0–30 s, poll 250 ms; a timeout is a normal `matched:false` result.
- Evidence: exact → normalized → context-assisted → fuzzy matching; fuzzy matches set `verified:false`; ambiguity never resolves to an arbitrary first hit; overlay is a closed-shadow-root, pointer-inert `aria-hidden` element; the highlight script re-verifies the raw text at the offsets before painting (≤3 retries).
- Text search folds case, diacritics, typographic punctuation and whitespace; `case_sensitive` uses exact `indexOf`. `zen_search_tabs` caps 30 tabs / 200 matches.

### 7.4 Coordination, persistence, audit
- `zen_progress` + `zen_events {after, waitSeconds}` implement a non-modal long-job loop with Stop. `zen_ask`/`zen_answers`, `zen_notify`, `zen_watch_*` handle user interaction/monitoring.
- Sessions snapshot every space/tab/folder/pin/essential with hard caps (100 sessions, 50 spaces, 2000 tabs, 8 MB file) and sanitization; restore reuses spaces by name (unless `newSpaces`), skips already-open URLs, restores folders/pins/essentials in batches of 30, and returns warnings instead of failing wholesale. Templates: 4 built-ins (`research`, `github-triage`, `news`, `docs`) plus user templates.
- Audit log: one JSON line per call, including blocked calls; depth-3/20-item/500-char/2048-char bounded summaries; sensitive keys and long strings become SHA-256 digests; URLs reduced to scheme+host+path; 5 MB rotation with one `.1` backup; owner-only modes; atomic writes with symlink refusal via `safe-file.ts`.

---

## 8. Data model / protocol (the vocabulary you must design)
Everything funnels through `src/shared/protocol.ts`. Key concepts:
- **Messages**: bridge→server (`auth.response`, `hello`, `browser.event`, `ui.answer`, `ui.stop`, `ui.consentResult`, `ui.bannerAction`, `res`, …) and server→bridge (`auth.challenge`, `auth.confirm`, `welcome`, `ui.ask`, `ui.progress`, `ui.consent`, `ui.banner`, `req`, `shutdown`, …).
- **Browser events**: kinds `tab|navigation|document|dialog`; phases `opened/closed/selected/started/committed/completed/failed/redirect/same_document/replaced/shown/hidden`; control kinds `stop|pause|resume|watch|question`.
- **Core entities**: `SpaceInfo`, `FolderInfo`, `TabInfo`, `HistoryEntry`, `BookmarkEntry`, `BridgeStatus`, `PageReadResult`, `PageElement`, `SemanticPage`, `EvidenceShowResult`/`BatchResult`, `TextMatch`, `WatchInfo`, `SessionSnapshot`, `UiQuestion`, `UiProgress`.
- **`BridgeMethodMap`**: the typed method→{params,result} contract (≈30 methods) — this is the exact API boundary between server and bridge.

---

## 9. Security model (summary)
- Trust boundaries: model/client → server (arguments only) → Marionette (owned) → chrome scripts (fixed) → bridge (authenticated) → page content (untrusted).
- Ownership: launch nonce + `moz:processID`; no attach path; Marionette lockdown after identity proof.
- Bridge: mutual HMAC per connection, fresh nonces, loopback only, fixed method map, version match.
- Consent/Pause/read-only/allowlist enforced outside the model, at both MCP guard and bridge hub.
- Page actions are real browser input; allowlist checks tab/frame/link URLs before and after, but cannot predict in-page scripts.
- Reads go through authenticated chrome only; private windows skipped; privileged/about/file pages refused; `http(s)` required.
- Audit redaction is risk reduction, not a guarantee; local same-user attackers (debugger, process memory) are out of scope.

---

## 10. Build & test
- `scripts/build.mjs`: two esbuild bundles — CLI for Node 22 (ESM, `packages:"external"`, `#!/usr/bin/env node` banner) and bridge for Firefox 128 (browser IIFE, no sourcemap, utf8). CLI is chmod 0755.
- Tests: unit suite over every module (policy, parsing, algorithms, helpers) plus three manual integration files requiring a live Zen + desktop session. CI: typecheck, build, unit tests on Node 22/24 across Windows/Ubuntu/macOS.

**Verified locally (evidence):** with the upstream checkout at `/tmp/opencode/zen-mcp-upstream`, `npm ci` installed 104 packages, `npm run build` produced `dist/cli.js` (~408 KB) and `dist/bridge.js` (~368 KB), `npm run typecheck` passed clean, and `npm test` reported **463 tests passing, 0 failing** in 72 suites (~5 s). The live integration suite (`test:zen`) was not run because it needs an installed Zen Browser and a desktop session.

- **CI** (`ci.yml`) runs `npm ci → typecheck → build → context:check → test` on Windows/Ubuntu/macOS × Node 22/24; `context:check` enforces the context budget (17-tool default surface, 1500-char instructions, 400-char description first paragraphs, surface growth limits). **Release** (`release.yml`) runs the same checks on a tag, packs a tarball with `SHA256SUMS`, creates a GitHub Release, and publishes to npm using OIDC trusted publishing (no stored npm token). The live Zen suite is deliberately not in CI or release.

### 10.1 The consumer skill — intended usage philosophy
The repo ships an agent *skill* (`skills/zen-mcp/SKILL.md`, <2000 tokens, plus seven reference files and an eval set) that teaches an agent how to use the tools well. Its mental model is worth stealing: **space = job, folder = result set, tab = source, ref = handle, evidence = receipt**. Its principles: inspect before acting; background first; reuse before opening (search/history/bookmarks); read the smallest thing that answers the question; an open page is not evidence, a verified quote is; Stop and Pause are final; clean up only what you created. It defines a "cheapest perception" ladder (`search_tabs` → `find_text` → selector read → metadata/outline → markdown/links/tables → batch read → text with pagination → snapshot/semantic) and playbooks for research, comparison, verification, triage, monitoring, page operation and recovery. `scripts/check-skill.mjs` validates the skill against the live tool surface (tool names, example args, enums, links, token budget) so docs cannot drift from code.

### 10.2 Roadmap / parked ideas (`docs/unsure-features.md`)
Ideas explicitly *not* approved: `zen_read_selection` (selection-aware reading), agent-facing `zen_doctor`, and `zen_screenshot`. Each has a decision checklist; screenshots in particular are gated on privacy/payload concerns. This tells us the project's deliberate boundary: text-first, no screenshots, no general WebDriver replacement.

---

## 11. How to build our own version — a pragmatic blueprint

*(This section is our design synthesis, not upstream text.)*

**Phase A — minimal vertical slice.** Get a stdio MCP server that can *launch a real browser with a debug port, prove and lock it down, inject a tiny bridge, and do one background read.* That proves the hardest mechanism first:
1. Config + CLI (stdio transport, stderr logging, signal shutdown).
2. Launcher + a minimal Marionette client (framing, NewSession, chrome context, executeAsyncScript, nonce check, lockdown, quit).
3. Bridge Hub with loopback WS + HMAC handshake + request/response correlation.
4. A single fixed bridge method (e.g. `status` and `tabs.read`) injected into chrome.
5. One MCP tool wired through a guard stub.

**Phase B — the research loop.** Add background open/list/read/search, pagination, frames, events, progress+Stop, consent/Pause, allowlist, audit. This is the product's core value.

**Phase C — interaction & evidence.** Ref registry, snapshot/semantic reads, strict target resolution, click/type with before/after effects, evidence matcher + overlay.

**Phase D — organization & persistence.** Spaces/folders/essentials/split/Glance via native APIs, sessions/templates, watches, history/bookmarks, onboarding.

**Key decisions to make for our version:**
- **Browser**: staying with Zen/Firefox gives native spaces/folders and a content actor for background reads. Chromium would require a different automation channel (CDP) and rethinking "spaces". Decide deliberately.
- **Ownership model**: an owned browser with a launch nonce is a strong boundary but means one browser per machine (Marionette port 2828) and no reuse of the user's signed-in session unless explicitly opted in. We can choose a different port strategy or an extension-based bridge.
- **Security boundary**: keep "no agent-supplied JS" and fixed scripts — it is the central safety property. Enforce consent/Pause at the request boundary, not just in tools.
- **Context economy**: small default tool surface + discovery tools is a nice pattern for token-limited clients; replicate or simplify.
- **Failure modes to handle**: Marionette session loss is unrecoverable by design; lockdown depends on Firefox internals; hidden PDFs are unreliable; redirects can escape an allowlist between checks. Decide how strict to be.
- **Observability**: event stream with monotonic cursors, bounded buffer, and "observation ≠ causation" semantics; audit with redaction and rotation.

**Things NOT to copy:** the specific Zen internal API names, the exact script bodies, and the branding — those are either brittle or the upstream project's identity. The durable ideas are the architecture, the trust boundaries, the background-read model, the typed protocol, and the algorithms described above.

---

# Appendices — concrete mechanism details

These appendices capture the finer-grained findings from a module-by-module deep read. They are still behavioral descriptions, not copied source.

## Appendix A — Page reading & in-browser scripts

**Injection model.** Every page operation is a **server-generated JavaScript *function body* string** executed through the browser's Marionette content actor (`MarionetteCommandsParent:executeScript`). Options are baked in with `JSON.stringify` as *data* (never evaluated as code), and shared helper blobs are inlined verbatim so reads, actions and evidence agree on labels, roles, sensitivity and text offsets. Scripts are deliberately synchronous so they work for background tabs. Every generator has a defensive Node-side `coerce*` twin that caps strings, clamps numbers, whitelists enums and strips unknown fields — e.g. snapshot/semantic element `value` is forced to `null` even if a script leaked one. This is the concrete implementation of "the model never supplies JavaScript".

**Read engine (`buildReadScript`).**
- Root selection: explicit `selector` else `article, main, [role=main]` for text/markdown/links/tables/metadata/outline, else `body` for interactive/snapshot/semantic. Text = normalized `innerText` (CRLF→LF, NBSP/tabs→spaces, collapse whitespace).
- Markdown: headless renderer supporting headings, paragraphs, fenced code (language class), nested UL/OL, blockquotes, GFM tables, images, links (absolute http(s)/mailto only), strong/em/del/code; skips SCRIPT/STYLE/NOSCRIPT/SVG/TEMPLATE/NAV/FOOTER/ASIDE.
- Caps: links 300, tables 20 / 100 rows / 12 cols / 300-char cells, headings 200, interactive controls 200, text 200k for coercion. Snapshot: 4k text preview, 100 controls (200 max), 80 headings (160 chars each).
- Pagination: offsets apply only to text/markdown; `nextOffset` = consumed length when more remains; structured/compact formats return complete data with `offset: 0` and a limitation.
- Frames: `framePath` arrays up to depth 3, ≤20 listed / ≤10 scanned depth-first, allowlist-filtered, refs prefixed `f0-e3` / `f0.1-e2`; completeness flags reflect frame discovery, not output caps.

**Interactive controls & sensitivity.** 22-alternative selector (links, buttons, inputs, textarea, select, summary, contenteditable, tabindex, common ARIA roles) plus recursion into all open shadow roots. Visible, connected controls only; ref = `"e"+(index+1)`. Accessible name precedence: aria-label → aria-labelledby → `<label>` → value/inner text → placeholder → title → alt → name. A field is sensitive if type ∈ {password,file,email,tel}, autocomplete matches a broad regex (passwords, one-time-code, cc-*, email, tel, address, username…), inputmode is email/tel, or name/id/placeholder/label matches a hint regex (secret/token/otp/cvv/card/iban/ssn/pin/email/phone/contact…). False positives are accepted: they only cost the value, never the ref/label.

**Semantic model.** Bounded walk (6k nodes, depth 10, 40 shadow roots) over visible, non-`aria-hidden` content; classifies landmarks (header/footer only without a sectioning ancestor, named forms/tables only), repeated structures (≥3 rich siblings → cards/results/links/items), headings, collections, dialogs. Classification is a deterministic point system (password→login +5, add-to-cart→product +4, ≥3 code blocks→documentation +3, price cards→product +3, search+results in main→search-results +3, etc.); best score <2 → generic; a near tie caps confidence at 0.6. Labels report provenance (aria/html/heading/inferred), zero/redundant fields are omitted, and coverage flags name every cap hit. No values, no hidden text.

**Target resolution.** Exactly one strategy (ref / role+name / text / label / placeholder / selector), with `match: exact|contains` only for role+name and text. Bounded scan (6k nodes, 6 matches, 6 shadow levels); ambiguity and truncation are surfaced (up to 5 candidates) instead of picking a first hit. A ref is a Marionette WebElement handle held in a server-side registry keyed by (tabId, framePath); before acting, a freshness script compares the captured document root handle (document identity) and an FNV digest of the descriptor (stale vs document-changed vs descriptor-changed).

**Evidence matcher.** 1) raw exact `indexOf`; 2) normalized (decode HTML entities, fold typographic punctuation/dashes/ellipses, NFKC, lowercase, strip Latin-only diacritics, collapse whitespace) with offsets mapped back to raw spans; 3) context-assisted scoring when repeated (token containment 0.45 + bigram overlap 0.3 + proximity 0.25 over ±240 chars, requiring score ≥0.2 and margin ≥0.1); 4) fuzzy token-anchored windows with bounded Levenshtein (only for quotes ≤300 chars), which enforces exact number multisets and negation-word counts so a match cannot flip a number or negation. Occurrence caps 50 (no context) / 300 (with context); near-ties → ambiguous; fuzzy matches are never `verified`. Painting re-walks the DOM with the same text walker and checks the raw slice at the chosen offsets still equals the matched text (≤3 retries); the overlay is a randomly named attribute + closed shadow root + pointer-inert boxes, never a DOM/text/style edit of the page.

**Text search** reuses the same canonicalizer as evidence (so `cafe` matches `Café`, `"` matches `“ ”`) and maps canonical offsets back to raw spans; `case_sensitive` falls back to literal `indexOf`.

**Action effects.** Before/after signatures hash rendered text and non-password form values (FNV-1a), count DOM elements, and record bounded control/heading/alert descriptors; the delta lists added/removed/changed controls (10), added/removed headings/alerts (5) and text-length delta, and refuses to diff across a replaced document. The effect always carries `attribution: "observed_after_action_not_proven"`. Typing verification compares the field value internally without returning it (sensitive fields are never read back).

## Appendix B — Bridge internals

- **Injection**: a chrome script enumerates `Services.wm` browser windows, skips private windows, registers a `resource://` alias to the bridge bundle directory, sets `window.__zenMcpConfig = {url, token, versions}`, then `loadSubScript`s `bridge.js` into each window. Re-injection reuses a healthy bridge or calls its `reconnect()`.
- **Content access**: reads/actions use the tab's `MarionetteCommands` actor via `currentWindowGlobal.getActor(...)`, not `contentDocument`, which is why background/other-space tabs work. Unavailable actor → `actor_unavailable`.
- **Tab identity**: lazy `tab-<uuid8>` ids via `WeakMap<tab,id>`/`Map<id,tab>`; pruned on close with a bounded closed-id set (so `newTab`/`tabClosed` waits can match); document identity is `doc-<innerWindowId>` but empty for the initial `about:blank` placeholder (waits can never match a placeholder).
- **Zen APIs used**: `gZenWorkspaces` (create/switch/delete), `gZenFolders`, `gZenPinnedTabManager` (essentials, with state save/restore), `gZenViewSplitter`, `gZenGlanceManager`, `gBrowser`, `PlacesUtils` (parameterized SQL), `SessionStore`, and the clipboard service. Native operations settle with small waits and verify the observed result (e.g. `tabs.select` retries activation and reports `windowFocused` from observation).
- **Ref registry**: one record per (tabId, framePath), 400 refs/doc default, LRU; refs carry the WebElement, a descriptor and an FNV digest; a new read replaces the document's whole ref set.
- **Event log**: bounded 200, monotonic cursor, browser observations expire after 10 min, 2 s dedup; on overflow the oldest *browser* observation is evicted first so control events survive; Pause hides browser observations at read time.
- **UI**: one open shadow root in chrome; banner/consent/questions/progress/activity cards, keyboard and aria support, WCAG-derived accent contrast, Stop retry across reconnects; card actions execute bridge-side and report back as `ui.action`.
- **Observers**: TabOpen/Close/Select, progress listeners (top-level navigation phases, document replacement), dialog observers (never reading text or dismissing). Events are stamped `source:"browser"` and validated/bounded on the host; off-list URLs are dropped and counted.

## Appendix C — MCP surface mechanics

- **One registration path**: all 55 tools are registered identically with a zod input shape, `outputSchema`, description and annotations, then wrapped by `guarded()`; after registration, tools outside the configured surface are moved into a `hiddenTools` map and deleted from `_registeredTools`. Discovery (`zen_tools_search` scoring by name/summary/category/keywords; `zen_tools_use` routing through the SDK's own validate+execute with the same guard/audit; `publish:true` re-registers and sends `tools/list_changed`) avoids a second implementation. `zen://capabilities` is the machine-readable catalog. Catalog invariants are checked at startup.
- **Schemas**: compacted for `tools/list` only (drop `$schema`/empty `additionalProperties`); loose/forward-compatible output schemas; success returns the same JSON as a text block and as `structuredContent`; only click/type model a structured `error` variant; every other error is text-only with `isError:true`.
- **Policy order**: cancellation → paused whitelist → URL collection (args + async callbacks for session/template/glance-by-id) → read-only + allowlist → handler (raced against AbortSignal) → audit outcome → resource-list-changed notification → result. Sanitized `notifications/message` on errors; the file audit log is authoritative.
- **Audit**: redaction of 14 sensitive argument keys and long strings, URL scheme/host/path only, depth/array/byte caps, 5 MB rotation with one backup, owner-only atomic writes; blocked calls are logged as `{ok:false, executed:false}`.
- **Bounded orchestration**: read_pages 10 tabs/3 workers, search_tabs 30/2 workers with 200-match cap, evidence batch 20 citations/≤5 per source/2–3 workers, 25 s event long-poll, 50 watches, 32 mutating tools blocked in read-only.
- **Progress/cancellation**: reporter is a no-op without a client progress token, otherwise strictly monotonic `notifications/progress`; abort rejects the wait but the in-browser command may finish — it is never reported as success.

## Appendix D — Control plane, persistence, onboarding, tests

- **Config merge order**: defaults → file → env, with safety booleans in the file required to be real booleans (otherwise throw), integer clamping, fail-closed enums/env booleans, and `saveConfig` deliberately reading the raw file so env overrides are never persisted. All logs to stderr.
- **Launch details**: args `-marionette -no-remote [-profile <dir>] [launchArgs]` (extra test args last); `-no-remote` prevents hand-off to an existing Zen that would ignore the agent profile. Port-open check before spawn; dedicated profile lock check / normal-profile running check. Spawn detached with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`, `ZEN_MCP_LAUNCHED=1`, `ZEN_MCP_LAUNCH_NONCE=<uuid>`. POSIX kills the whole process group via negative pid; Windows uses `taskkill /T /F`.
- **Marionette**: length-prefixed JSON frames, `WebDriver:NewSession` → timeouts → chrome context; all scripts use `ExecuteAsyncScript` with a wrapper that returns `{__zenMcpOk, value}` or a described error; `SwitchToWindow` defaults `focus:false`; content calls serialized because context is session-global. Ownership proof via `Services.env` nonce; lockdown imports `Marionette.sys.mjs`, closes other connections and calls `setAcceptConnections(false)`.
- **Sessions/templates**: caps 100 sessions / 50 spaces / 2000 tabs / 200 folders, 8 MiB files, batches of 30, default restore max 300 tabs; restore reuses spaces by lowercase name, skips already-open URLs, recreates pins/folders/essentials with per-item warnings. Templates have 4 built-ins (`research`, `github-triage`, `news`, `docs`) and user templates; apply creates uniquely named spaces; built-ins cannot be deleted. Both sanitize on read and write atomically owner-only with symlink refusal.
- **Doctor / updates / tab-audit**: doctor is static only (never connects) and warns when consent/read-only/allowlist/audit are weakened; update check is semver-aware and failure-tolerant, prompt-once per release in `update.json`, with Windows installer hardening against cwd hijacking; tab-audit defaults stale 14 days, duplicate normalization (lowercase, strip hash/trailing slash), domain grouping with `www.` stripped, and `planDomainFolders` for ungrouped/unpinned tabs.
- **Onboarding**: 28 MCP client definitions with format-specific mergers (JSON, JSONC via a hand-written comment/trailing-comma-preserving scanner, TOML, YAML, shell), platform path resolution (`APPDATA` / `~/Library/Application Support` / XDG) plus per-client env overrides, idempotent `zen-mcp` entry replacement that preserves comments and other servers, an interactive TTY multiselect picker (detected clients preselected), and a paste-ready "other client" runbook. This is a good example of a *local* concern kept outside the browser-control core.
- **Tests as contract documentation**: unit tests cover config/clamping, launcher/marionette helpers, session/template round-trips and malformed data, onboard merge formats, update semver/installer safety, tab-audit heuristics, discovery/policy propagation, read-only no-auto-launch, and safe-file behavior; opt-in live integration tests (headless disposable profile) cover real ownership/consent/Pause/shutdown, background reads, evidence disambiguation, page interaction, sessions/templates and policy blocks. Integration files run serially because one Marionette port cannot be shared.

## Final takeaway

The durable, transferable ideas are: (1) an owned browser with a cryptographic identity proof and an immediately closed debug port; (2) a privileged in-browser bridge with a *fixed* method map and mutually authenticated loopback channel, so the model can never supply code; (3) background, actor-based page reads with strict bounds and value-free formats; (4) policy enforced at multiple boundaries, fail-closed, with an authoritative redacted audit log; (5) an event stream with cursor/observation semantics; (6) a small default tool surface plus a discovery gateway to keep context cost down; and (7) evidence that is verified in-page and shown to the human. Everything else — Zen's internal API names, the exact script bodies, the 55-tool surface, and the branding — is an implementation choice we are free to redesign.
