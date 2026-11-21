import test from "node:test";
import assert from "node:assert/strict";
import { BRAND, SERVER_VERSION, BRIDGE_PROTOCOL_VERSION } from "../../src/shared/brand.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { isUrlAllowed, normalizeDomainList, normalizeWebUrl } from "../../src/shared/url-policy.js";
import { errorMetadata } from "../../src/shared/errors.js";
import { wrapScript } from "../../src/zen/marionette.js";
import { buildLaunchArgs, resolvedProfilePath, parsePosixLockPid } from "../../src/zen/launcher.js";
import { ALL_TOOL_NAMES, toolsForSurface, validateCatalog } from "../../src/mcp/catalog.js";
import { findEvidenceQuote, canonicalizeEvidenceText } from "../../src/shared/evidence.js";
import { findLiteralMatches } from "../../src/shared/search.js";
import { normalizeTargetInput } from "../../src/shared/target.js";
import { EventLog } from "../../src/bridge/event-log.js";
import { ToolGuard, redactUrlForAudit } from "../../src/mcp/guard.js";

test("foundation identity and config defaults", () => {
  assert.equal(BRAND, "Zen Control");
  assert.ok(SERVER_VERSION);
  assert.equal(BRIDGE_PROTOCOL_VERSION, 2);
  assert.equal(DEFAULT_CONFIG.toolSurface, "research");
  assert.equal(DEFAULT_CONFIG.marionettePort, 2828);
  assert.equal(DEFAULT_CONFIG.requireConsent, true);
});

test("url policy", () => {
  assert.equal(normalizeWebUrl("example.com/path")?.href, "https://example.com/path");
  assert.equal(normalizeWebUrl("javascript:alert(1)"), null);
  assert.deepEqual(normalizeDomainList(["*.Example.com", "."]), ["example.com"]);
  assert.equal(isUrlAllowed("https://sub.example.com/a", ["example.com"]), true);
  assert.equal(isUrlAllowed("https://evil-example.com/a", ["example.com"]), false);
  assert.equal(isUrlAllowed("https://x.test/a", []), true);
});

test("error metadata", () => {
  assert.equal(errorMetadata("stale_reference").category, "stale_reference");
  assert.equal(errorMetadata("click_failed").stateChanged, null);
  assert.equal(errorMetadata("read_only").category, "permission");
});

test("marionette script wrapper carries error details", () => {
  const wrapped = wrapScript("return 1;");
  assert.match(wrapped, /__zenMcpOk/);
  assert.match(wrapped, /async/);
  assert.match(wrapped, /return 1;/);
});

test("launcher arg construction", () => {
  const built = buildLaunchArgs({ profilePath: "/tmp/prof", launchArgs: ["--headless"] }, ["--test"]);
  assert.equal(built.args[0], "-marionette");
  assert.equal(built.args[1], "-no-remote");
  assert.ok(built.args.includes("-profile"));
  assert.ok(built.args.includes("--headless"));
  assert.equal(built.args.at(-1), "--test");
  assert.equal(resolvedProfilePath({ useDefaultProfile: true }), null);
  assert.equal(parsePosixLockPid("127.0.0.1:+12345"), 12345);
});

test("catalog surfaces are nested and complete", () => {
  assert.deepEqual(validateCatalog(), []);
  assert.equal(ALL_TOOL_NAMES.length, 56);
  assert.equal(toolsForSurface("research").size, 17);
  assert.equal(toolsForSurface("core").size, 38);
  assert.equal(toolsForSurface("full").size, 56);
  for (const name of toolsForSurface("research")) {
    assert.ok(toolsForSurface("core").has(name));
    assert.ok(toolsForSurface("full").has(name));
  }
});

test("evidence canonicalization and matching", () => {
  const canonical = canonicalizeEvidenceText("Café — “hello”");
  assert.match(canonical.text, /cafe/);
  const hit = findEvidenceQuote("The result was 42 seconds.", {
    quote: "The result was 42 seconds.",
  });
  assert.equal(hit.ok, true);
  assert.equal(hit.method, "exact");
  const miss = findEvidenceQuote("Nothing here.", {
    quote: "completely unrelated passage about quantum llamas",
  });
  assert.equal(miss.ok, false);
});

test("literal search folds case and punctuation", () => {
  const found = findLiteralMatches("Café and “hello”", {
    query: '"hello"',
  });
  assert.equal(found.totalMatches, 1);
  assert.equal(found.matches[0].text, "“hello”");
});

test("target normalization enforces one strategy", () => {
  const normalized = normalizeTargetInput({ ref: "e3" });
  assert.equal(normalized.kind, "ref");
  assert.equal(normalized.value, "e3");
  assert.equal(normalized.legacy, true);
  assert.throws(() => normalizeTargetInput({ ref: "e3", selector: "button" }));
  assert.throws(() => normalizeTargetInput({ target: {} }));
});

test("event log is bounded and cursor-driven", () => {
  const log = new EventLog();
  for (let i = 0; i < 250; i += 1) {
    log.push({ kind: "watch", title: `event ${i}` });
  }
  const read = log.read(0);
  assert.ok(read.events.length <= 200);
  assert.ok(read.cursor >= 250);
  assert.ok(read.missed > 0);
});

test("audit redaction", () => {
  assert.equal(redactUrlForAudit("https://user:secret@example.com/p?q=1#f"), "https://example.com/p");
  const guard = new ToolGuard({ readOnly: false, allowedDomains: [], auditLog: false, dataDir: "/tmp" });
  guard.check("zen_tabs_open", { urls: ["https://example.com"] });
  const readOnlyGuard = new ToolGuard({ readOnly: true, allowedDomains: [], auditLog: false, dataDir: "/tmp" });
  assert.throws(() => readOnlyGuard.check("zen_click", {}), /read.only/i);
});
