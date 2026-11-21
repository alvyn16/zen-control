# Testing Zen Control

## Unit tests

Unit tests need no browser and are the default test command:

```bash
npm ci
npm run typecheck          # strict TypeScript, no emit
npm run build              # bundles dist/cli.js and dist/bridge.js
npm test                   # node:test suite under test/unit
npm run check              # typecheck + build + unit tests
```

Run a single file while developing:

```bash
node --import tsx --test test/unit/zz-smoke.test.ts
```

Unit tests use only `node:test`, `node:assert/strict`, temporary directories
under `os.tmpdir()`, and no live browser.

## Live integration smoke test

`test/integration/live-smoke.test.ts` is always collected by the test runner
but is a no-op unless `ZEN_CONTROL_E2E` is exactly `1`. It starts a small local
HTTP server with a deterministic page (one quote and one button), writes a
throwaway config and fresh profile under `os.tmpdir()`, spawns the **built**
CLI over stdio, and exercises discovery plus the read/verify/interact lifecycle
against a real headless Zen Browser. It never reads or changes your normal
Zen profile or config.

```bash
npm run build
ZEN_CONTROL_E2E=1 npm run test:live
```

With a Zen binary that is not at the default path:

```bash
npm run build
ZEN_CONTROL_E2E=1 ZEN_CONTROL_ZEN_PATH=/path/to/zen npm run test:live
```

Environment variables:

| Variable | Effect |
| --- | --- |
| `ZEN_CONTROL_E2E` | Must be exactly `1` to run; otherwise the test is skipped. |
| `ZEN_CONTROL_ZEN_PATH` | Executable to point the temp config at. Defaults to `/usr/bin/zen-browser`. |

The spawned server also receives `ZEN_CONTROL_CONFIG` (the temporary config
path) and `ZEN_CONTROL_NO_UPDATE_CHECK=1`. Other inherited `ZEN_CONTROL_*`
variables are deliberately stripped so no developer environment override can
change the test's policy. The test uses a fresh headless profile (`--headless`
in `launchArgs`), `requireConsent:false`, `autoLaunch:true`, `auditLog:false`,
`toolSurface:"full"` and a 45-second launch timeout. Cleanup closes the MCP
client, the HTTP server and the temporary directory even when an assertion
fails.

The test asserts that the full surface exposes 56 tools and 6 resources, then
calls `zen_status`, `zen_tabs_open`, `zen_tabs_list`, `zen_read_page` (text and
semantic), `zen_find_text`, `zen_show_evidence` (requiring `verified: true`),
`zen_click`, `zen_wait_for`, `zen_config`, `zen_doctor` and `zen_tabs_close`.

## Continuous integration

`.github/workflows/ci.yml` runs the unit matrix (`test`) first. A second job,
`live-smoke`, depends on it and runs on `ubuntu-latest` with Node 24: it
downloads the official Linux x86_64 Zen release from `zen-browser/desktop`,
extracts it, locates the `zen`/`zen-bin` executable, and runs the gated smoke
test headlessly with a 15-minute job timeout. No manual steps or desktop
session are needed.
