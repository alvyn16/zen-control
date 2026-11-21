<p align="center">
  <img src="assets/zen-control-logo.svg" width="96" height="96" alt="Zen Control logo: separated coral rings forming a spiral in Zen Browser's paper and charcoal palette">
</p>

# Zen Control

Zen Control is a **Model Context Protocol (MCP) server** that gives an AI agent
controlled access to a real [Zen Browser](https://zen-browser.app/) window
(Zen is a Firefox fork). It starts and *owns* a browser with a debug port,
proves that the browser answering on that port is the one it launched, closes
the port to everyone else, and injects a small authenticated bridge into the
browser's privileged scope. On top of that bridge it exposes a typed MCP tool
surface for background research, page reads, tab/spaces operations, evidence
highlights, and in-browser questions.


## What makes it different

- **Owned browser, never attached.** Zen Control launches its own Zen process with
  a launch nonce, verifies the nonce inside the browser, then locks the debug
  port. It never takes over a browser you are using.
- **Background first.** Reads happen through Zen's content actor, so the agent
  can inspect many tabs without moving your focus, selection or scroll.
- **The model never supplies JavaScript.** The bridge exposes a fixed method
  map; page reads and actions are generated from structured arguments only.
- **You stay in control.** First-use consent, a global Pause, read-only mode, a
  domain allowlist and a redacted audit log are enforced outside the model.

## Requirements

- Node.js **22 or newer**.
- Zen Browser installed (or a Zen executable path supplied via config).
- A desktop session for any command that launches a real browser. The MCP
  server, config, doctor and onboarding commands work headlessly.

## Install and build

```bash
npm ci
npm run build          # bundles dist/cli.js and dist/bridge.js
npm run typecheck      # strict TypeScript, no emit
npm test               # node:test unit suite
npm run check          # typecheck + build + test
```

Run without installing globally:

```bash
node dist/cli.js setup
node dist/cli.js serve
```

Or install the built package and use the `zen-control` binary:

```bash
npm install -g zen-control
zen-control setup
```

## CLI

```
zen-control [command]

Commands:
  serve       Run the MCP server over stdio (the default command)
  launch      Launch a Zen window, verify lockdown, then quit it
  status      Print resolved config and port state without a session
  doctor      Check the Zen install, config, profile and Marionette port
  update      Check npm for a newer release and install it
  setup       Detect Zen, write a config file, print a client snippet
  onboard     Add Zen Control to MCP client configurations
  config show Print the config path and resolved values
  config set  Set one configuration key
```

Useful flags:

- `update --check` reports versions without installing; `--manager <npm|pnpm|yarn|bun>` picks an installer.
- `setup --zen-path`, `--profile`, `--use-default-profile`, `--dedicated-profile`,
  `--no-auto-launch`, `--ask-timeout`, `--marionette-port`, `--skip-doctor`.
- `onboard --clients claude-code,cursor,other` skips the interactive picker;
  `--command <path>` overrides the client command.

`serve` is the default action, so `zen-control` with no arguments starts the
server. All diagnostics are written to **stderr**; stdout is reserved for the
MCP JSON-RPC transport.

## MCP client configuration

`setup` prints the snippet you can paste into a client that is not in the
onboarding catalog:

```json
{
  "mcpServers": {
    "zen-control": {
      "command": "zen-control",
      "args": ["serve"]
    }
  }
}
```

Use `zen-control onboard` to write the entry into a supported client. The catalog
covers 28 clients, including Claude Code/Desktop, Cursor, VS Code, Codex,
Gemini CLI, Windsurf, Cline, Zed, OpenCode, oh-my-pi, DeepSeek Harness, ZCode,
Roo Code, Kilo Code, Continue, Amp, Crush, Qwen Code, Kiro, Warp, Copilot CLI,
Factory Droid, Amazon Q, Goose, LM Studio, Junie and Pi. JSON, JSONC, TOML and
YAML/shell configurations are merged in place: existing servers, comments and
trailing commas are preserved, and only the `zen-control` entry is replaced.
For anything else, `onboard --other` prints a paste-ready setup runbook with
config paths, entry shapes, merge rules, a validation checklist and a
completion report.

If `zen-control` is not on your PATH, use the absolute path to `dist/cli.js` as
the command and keep `args` as `["serve"]`.

## First-use consent

The default profile is a dedicated agent profile, so your signed-in Zen
profile is untouched. On the first tool call that needs the browser, Zen shows
an approval card in the browser chrome. Nothing connects until you click
**Allow**. Denial closes the browser the agent started. You can pre-approve
with:

```bash
zen-control launch
```

That command launches a temporary owned browser, performs the one-shot
ownership and lockdown check, prints the result, and quits it. The MCP server
keeps its browser alive for the whole session and shuts it down cleanly on
SIGINT/SIGTERM or when the transport closes.

## Tool surfaces

Tools are grouped into three nested surfaces:

| Surface | Tools | Purpose |
| --- | --- | --- |
| `research` (default) | reads, search, tab listing, evidence, events, questions | smallest useful surface for token-limited clients |
| `core` | research plus interaction and layout operations | click/type, spaces, folders, essentials, split view |
| `full` | everything | history, bookmarks, sessions, templates, diagnostics |

The surface only changes which tools are listed, not what the gateway can do.
Discovery tools let an agent find and enable tools outside the active surface
without a second implementation of the handler path.

## Safety controls

- **Consent** is required at the request boundary, not only in tool wrappers.
- **Pause** rejects in-flight requests and blocks mutating tools until resumed;
  a small control allowlist (events, answers, config, audit tail) stays live.
- **Read-only** mode blocks mutating tools before any handler runs.
- **Domain allowlist** checks normalized `http(s)` URLs; a non-http URL or a
  host outside the list is rejected. An empty list allows everything.
- **No agent-supplied JavaScript.** The bridge method map is fixed and
  arguments are validated and bounded.
- **Audit log** records one redacted JSON line per call, including blocked
  calls, with owner-only atomic writes and symlink refusal.
- **Fail-closed config.** Environment booleans and enums throw on malformed
  values, numeric values are clamped, and policy fields in the config file
  must be real JSON booleans/arrays.

## Architecture overview

```
MCP client (Claude Code, Cursor, OpenCode, ...)
        |  JSON-RPC over stdio
        v
+--------------------------- Node server ---------------------------+
|  CLI -> MCP server -> guard (consent, pause, read-only, allowlist, |
|                              audit) -> ZenRuntime orchestrator     |
|  BridgeHost: loopback WebSocket, HMAC handshake, request routing   |
+----------------------+--------------------------+------------------+
                       | Marionette (127.0.0.1)   | authenticated WS
                       v                          v
              Zen chrome scope            injected bridge (per window)
              nonce, lockdown             fixed method map, UI cards
                       \                          /
                        v                        v
                    gBrowser / spaces / folders / content actor
```

Key modules:

- `src/cli.ts` — commander entry point and one-shot diagnostics.
- `src/config.ts` — schema, defaults, env overrides, atomic saves.
- `src/zen/runtime.ts` — owns the browser lifecycle and high-level operations.
- `src/zen/launcher.ts` — executable detection, launch args, profile locks.
- `src/bridge/` — WebSocket host, mutual authentication, bridge runtime.
- `src/mcp/` — catalog, guard, server and tool implementations.
- `src/shared/` — protocol types, URL policy, evidence/search/target helpers.
- `src/onboard/` — 28-client catalog, mergers, picker and terminal theme.

## Configuration

The config file lives at `%APPDATA%/zen-control/config.json` on Windows,
`~/Library/Application Support/zen-control/config.json` on macOS, and
`$XDG_CONFIG_HOME/zen-control/config.json` (or `~/.config/zen-control/config.json`)
elsewhere. `ZEN_CONTROL_CONFIG` overrides the path. `ZEN_CONTROL_*` environment
variables override file values. Run `zen-control config show` to see the
resolved values and `zen-control config set <key> <value>` to change one key.

## Development and tests

```bash
npm run typecheck                       # strict TypeScript
npm run build                           # esbuild bundles
npm test                                # all unit tests
node --import tsx --test test/unit/foo.test.ts   # a single file
npm run check                           # all of the above
```

Unit tests use only `node:test` and `node:assert/strict`, temporary directories
under `os.tmpdir()`, and no live browser. Integration tests that need a real
Zen session are opt-in and are not part of `npm test`.

## License

MIT.
