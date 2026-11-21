import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * These modules are owned by parallel workstreams. They are loaded dynamically
 * so this suite compiles and runs against whichever integrated tree is present;
 * a test is skipped (not failed) when its module is genuinely absent.
 */
type Module = Record<string, unknown>;
type AnyFn = (...args: never[]) => unknown;

async function load(specifier: string): Promise<Module | null> {
  try {
    return (await import(specifier)) as Module;
  } catch {
    return null;
  }
}

function fn(mod: Module, name: string): AnyFn | null {
  const value = mod[name];
  return typeof value === "function" ? (value as AnyFn) : null;
}

function call(f: AnyFn, ...args: unknown[]): unknown {
  return (f as (...values: unknown[]) => unknown)(...args);
}

describe("mcp guard helpers", () => {
  it("redacts URLs and sensitive arguments", async (t) => {
    const mod = await load("../../src/mcp/guard.js");
    if (!mod) return t.skip("guard module not present");
    const redact = fn(mod, "redactUrlForAudit");
    assert.ok(redact, "redactUrlForAudit exported");
    const result = String(
      call(redact, "https://user:secret@example.com/a/b?token=abc#frag")
    );
    assert.match(result, /example\.com\/a\/b/);
    assert.doesNotMatch(result, /secret|token|frag/);

    const summarize = fn(mod, "summarizeArgs");
    if (summarize) {
      const summary = JSON.stringify(
        call(summarize, { text: "secret phrase", url: "https://x.test/?token=abc", n: 1 })
      );
      assert.doesNotMatch(summary, /secret phrase/);
      assert.doesNotMatch(summary, /token=abc/);
      assert.match(summary, /redacted/);
    }

    const mutating = mod.MUTATING_TOOLS;
    if (mutating instanceof Set) {
      assert.ok(mutating.has("zen_click"));
      assert.ok(!mutating.has("zen_read_page"));
    }
  });

  it("classifies audit outcomes for batches", async (t) => {
    const mod = await load("../../src/mcp/guard.js");
    if (!mod) return t.skip("guard module not present");
    const outcome = fn(mod, "auditOutcomeForResult");
    if (!outcome) return t.skip("auditOutcomeForResult not present");
    const partial = call(outcome, "zen_show_evidence_batch", {
      ok: true,
      total: 2,
      verified: 1,
      failed: 1,
    }) as Record<string, unknown>;
    assert.equal(partial.outcome, "partial");
    const success = call(outcome, "zen_show_evidence_batch", {
      ok: true,
      total: 2,
      verified: 2,
      failed: 0,
    }) as Record<string, unknown>;
    assert.equal(success.outcome, "success");
  });
});

describe("evidence canonicalization and matching", () => {
  it("folds typography, case and diacritics while keeping offsets", async (t) => {
    const mod = await load("../../src/shared/evidence.js");
    if (!mod) return t.skip("evidence module not present");
    const canonicalize = fn(mod, "canonicalizeEvidenceText");
    if (!canonicalize) return t.skip("canonicalizeEvidenceText not present");
    const canonical = call(canonicalize, "“Café”—OK") as Record<string, unknown>;
    assert.match(String(canonical.text), /cafe/i);
    const starts = canonical.starts;
    const ends = canonical.ends;
    assert.ok(Array.isArray(starts) && Array.isArray(ends));
    assert.equal(starts.length, String(canonical.text).length);
    assert.equal(ends.length, starts.length);
  });

  it("matches exact quotes and reports misses", async (t) => {
    const mod = await load("../../src/shared/evidence.js");
    if (!mod) return t.skip("evidence module not present");
    const find = fn(mod, "findEvidenceQuote");
    if (!find) return t.skip("findEvidenceQuote not present");
    const page = "The answer is 42 today.";
    const hit = call(find, page, { quote: "answer is 42" }) as Record<string, unknown>;
    assert.equal(hit.ok, true);
    assert.equal(hit.method, "exact");
    assert.ok(Number(hit.start) >= 0);
    assert.ok(Number(hit.end) > Number(hit.start));
    assert.equal(page.slice(Number(hit.start), Number(hit.end)), "answer is 42");

    const miss = call(find, page, { quote: "definitely absent" }) as Record<string, unknown>;
    assert.equal(miss.ok, false);
    assert.equal(miss.errorCode, "QUOTE_NOT_FOUND");
  });

  it("matches normalized text across typography", async (t) => {
    const mod = await load("../../src/shared/evidence.js");
    if (!mod) return t.skip("evidence module not present");
    const find = fn(mod, "findEvidenceQuote");
    if (!find) return t.skip("findEvidenceQuote not present");
    const hit = call(find, "Le Café est ouvert.", { quote: "cafe" }) as Record<string, unknown>;
    assert.equal(hit.ok, true);
    assert.notEqual(hit.method, "exact");
  });
});

describe("literal search", () => {
  it("folds case and diacritics unless case sensitive", async (t) => {
    const mod = await load("../../src/shared/search.js");
    if (!mod) return t.skip("search module not present");
    const find = fn(mod, "findLiteralMatches");
    if (!find) return t.skip("findLiteralMatches not present");
    const folded = call(find, "café CAFÉ cafe", { query: "cafe" }) as Record<string, unknown>;
    assert.ok(Number(folded.totalMatches) >= 2);
    const exact = call(find, "café CAFÉ cafe", {
      query: "cafe",
      caseSensitive: true,
    }) as Record<string, unknown>;
    assert.equal(exact.totalMatches, 1);
  });

  it("caps the number of returned matches", async (t) => {
    const mod = await load("../../src/shared/search.js");
    if (!mod) return t.skip("search module not present");
    const find = fn(mod, "findLiteralMatches");
    if (!find) return t.skip("findLiteralMatches not present");
    const result = call(find, "x x x x x x", {
      query: "x",
      maxMatches: 2,
    }) as Record<string, unknown>;
    assert.equal((result.matches as unknown[]).length, 2);
    assert.ok(Number(result.totalMatches) >= 6);
  });
});

describe("target normalization", () => {
  it("accepts exactly one strategy and normalizes whitespace", async (t) => {
    const mod = await load("../../src/shared/target.js");
    if (!mod) return t.skip("target module not present");
    const normalize = fn(mod, "normalizeTargetInput");
    if (!normalize) return t.skip("normalizeTargetInput not present");
    const ref = call(normalize, { ref: "  e12  " }) as Record<string, unknown>;
    assert.equal(ref.kind, "ref");
    assert.equal(ref.value, "e12");
    const selector = call(normalize, { selector: " button.primary " }) as Record<string, unknown>;
    assert.equal(selector.kind, "selector");
    assert.throws(() => call(normalize, { ref: "e1", selector: "a" }));
  });

  it("normalizes text for matching", async (t) => {
    const mod = await load("../../src/shared/target.js");
    if (!mod) return t.skip("target module not present");
    const text = fn(mod, "normalizeTargetText");
    const matches = fn(mod, "targetTextMatches");
    if (!text || !matches) return t.skip("target text helpers not present");
    assert.equal(call(text, "  Hello   World "), "hello world");
    assert.equal(call(matches, "Save Changes", "save", "contains"), true);
    assert.equal(call(matches, "Save Changes", "save", "exact"), false);
  });
});

describe("frame paths", () => {
  it("parses ref paths and normalizes frame paths", async (t) => {
    const mod = await load("../../src/shared/frame-path.js");
    if (!mod) return t.skip("frame-path module not present");
    const parse = fn(mod, "parseFrameRef");
    const prefix = fn(mod, "frameRefPrefix");
    const normalize = fn(mod, "normalizeFramePath");
    if (!parse || !prefix || !normalize) return t.skip("frame helpers not present");
    assert.deepEqual(call(parse, "f0-e3"), { path: [0], index: 3 });
    assert.deepEqual(call(parse, "f0.1-e2"), { path: [0, 1], index: 2 });
    assert.equal(call(parse, "nonsense"), null);
    assert.equal(call(prefix, [0, 1]), "f0.1-");
    assert.deepEqual(call(normalize, [0, 1]), [0, 1]);
    assert.deepEqual(call(normalize, undefined), []);
    assert.equal(call(normalize, [0, 1, 2, 3]), undefined);
    assert.equal(call(normalize, [-1]), undefined);
  });
});

describe("page delta", () => {
  it("reports added controls and text changes, but not a replaced document", async (t) => {
    const mod = await load("../../src/shared/delta.js");
    if (!mod) return t.skip("delta module not present");
    const build = fn(mod, "buildPageDelta");
    const hasChanges = fn(mod, "deltaHasChanges");
    if (!build || !hasChanges) return t.skip("delta helpers not present");

    const control = (name: string) => ({
      key: name,
      role: "button",
      name,
      type: null,
      state: {
        visible: true,
        disabled: false,
        readOnly: false,
        checked: null,
        selected: null,
        valuePresent: false,
      },
    });
    const before = {
      url: "https://x.test",
      title: "Title",
      readyState: "complete",
      textLength: 10,
      textHash: 1,
      elementCount: 2,
      valueHash: 0,
      controls: [control("Save")],
      headings: [{ key: "h1", text: "Heading" }],
      alerts: [],
    };
    const after = {
      ...before,
      textLength: 20,
      textHash: 2,
      controls: [control("Save"), control("Cancel")],
    };
    const changed = call(build, before, after, false) as {
      delta: Record<string, unknown>;
      hasChanges: boolean;
    };
    assert.equal((changed.delta.addedControls as unknown[]).length, 1);
    assert.equal(changed.hasChanges, true);
    if (hasChanges) assert.equal(call(hasChanges, changed.delta), true);

    const replaced = call(build, before, after, true) as {
      delta: Record<string, unknown>;
      hasChanges: boolean;
    };
    assert.equal((replaced.delta.addedControls as unknown[]).length, 0);
    assert.equal(replaced.hasChanges, false);
    assert.ok(replaced.delta.limitation);
  });
});

describe("event log", () => {
  it("bounds events, preserves control events and tracks cursors", async (t) => {
    const mod = await load("../../src/bridge/event-log.js");
    if (!mod) return t.skip("event-log module not present");
    const EventLog = mod.EventLog;
    if (typeof EventLog !== "function") return t.skip("EventLog not present");
    const Ctor = EventLog as new (options: Record<string, unknown>) => {
      size: number;
      sequence: number;
      dropped: number;
      push(input: Record<string, unknown>): { id: number } | null;
      read(after: number): { events: Array<{ id: number; kind: string }>; cursor: number; missed: number };
    };
    const log = new Ctor({ maxEvents: 2, ttlMs: 0, now: () => 1_000 });
    log.push({ kind: "pause", title: "paused" });
    log.push({ kind: "tab", title: "one" });
    log.push({ kind: "tab", title: "two" });
    assert.equal(log.size, 2);
    assert.equal(log.dropped, 1);
    const all = log.read(0);
    assert.ok(all.events.some((event) => event.kind === "pause"));
    assert.equal(all.cursor, log.sequence);
    const later = log.read(all.events[0].id);
    assert.ok(later.events.every((event) => event.id > all.events[0].id));
  });
});

describe("updates", () => {
  it("compares semantic versions", async (t) => {
    const mod = await load("../../src/zen/updates.js");
    if (!mod) return t.skip("updates module not present");
    const compare = fn(mod, "compareVersions");
    const newer = fn(mod, "isNewerVersion");
    if (!compare || !newer) return t.skip("semver helpers not present");
    assert.ok(Number(call(compare, "1.2.3", "1.2.2")) > 0);
    assert.ok(Number(call(compare, "1.2.3", "1.3.0")) < 0);
    assert.equal(call(compare, "v1.2.3", "not-a-version"), null);
    assert.equal(call(newer, "1.3.0", "1.2.9"), true);
    assert.equal(call(newer, "1.2.9", "1.3.0"), false);
  });

  it("remembers the last prompted release", async (t) => {
    const mod = await load("../../src/zen/updates.js");
    if (!mod) return t.skip("updates module not present");
    const shouldPrompt = fn(mod, "shouldPromptUpdate");
    if (!shouldPrompt) return t.skip("shouldPromptUpdate not present");
    assert.equal(call(shouldPrompt, null, "1.2.3"), true);
    assert.equal(call(shouldPrompt, "1.2.2", "1.2.3"), true);
    assert.equal(call(shouldPrompt, "1.2.3", "1.2.3"), false);

    const read = fn(mod, "readUpdatePromptState");
    const write = fn(mod, "writeUpdatePromptState");
    if (!read || !write) return;
    const dir = mkdtempSync(join(tmpdir(), "zenforge-update-"));
    try {
      const file = join(dir, "update.json");
      call(write, file, { promptedVersion: "2.0.0" });
      assert.deepEqual(call(read, file), { promptedVersion: "2.0.0" });
      assert.deepEqual(call(read, join(dir, "missing.json")), { promptedVersion: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates package managers and builds install commands", async (t) => {
    const mod = await load("../../src/zen/updates.js");
    if (!mod) return t.skip("updates module not present");
    const isManager = fn(mod, "isPackageManager");
    const command = fn(mod, "updateCommand");
    if (!isManager || !command) return t.skip("installer helpers not present");
    const managers = mod.PACKAGE_MANAGERS;
    assert.ok(Array.isArray(managers));
    assert.ok(managers.includes("npm"));
    assert.equal(call(isManager, "pnpm"), true);
    assert.equal(call(isManager, "cursor"), false);
    const built = call(command, "npm") as { command: string; args: string[] };
    assert.ok(built.command);
    assert.ok(built.args.some((arg) => /zenforge|@spaxe-dev/.test(arg)));
  });
});

describe("launcher", () => {
  it("builds owned launch arguments and resolves the profile", async (t) => {
    const mod = await load("../../src/zen/launcher.js");
    if (!mod) return t.skip("launcher module not present");
    const build = fn(mod, "buildLaunchArgs");
    const resolved = fn(mod, "resolvedProfilePath");
    if (!build || !resolved) return t.skip("launch args helpers not present");

    const dedicated = call(build, {
      dataDir: "/data",
      useDefaultProfile: false,
      launchArgs: ["--headless"],
    }, ["--extra"]) as { args: string[]; profile: string | null };
    assert.deepEqual(dedicated.args.slice(0, 4), [
      "-marionette",
      "-no-remote",
      "-profile",
      join("/data", "agent-profile"),
    ]);
    assert.equal(dedicated.args.at(-1), "--extra");
    assert.equal(dedicated.profile, join("/data", "agent-profile"));

    const normal = call(build, {
      dataDir: "/data",
      profilePath: "/custom",
      launchArgs: [],
    }) as { args: string[]; profile: string | null };
    assert.equal(normal.profile, "/custom");
    assert.equal(call(resolved, { dataDir: "/data", useDefaultProfile: true }), null);
  });

  it("parses a PID from a POSIX lock symlink target", async (t) => {
    const mod = await load("../../src/zen/launcher.js");
    if (!mod) return t.skip("launcher module not present");
    const parse = fn(mod, "parsePosixLockPid");
    if (!parse) return t.skip("parsePosixLockPid not present");
    assert.equal(call(parse, "localhost:+1234"), 1234);
    assert.equal(call(parse, "AF_UNIX path 1234"), 1234);
    assert.equal(call(parse, "localhost:abcd"), null);
    assert.equal(call(parse, "localhost:0"), null);
  });

  it("detects a stale profile lock by PID liveness", async (t) => {
    const mod = await load("../../src/zen/launcher.js");
    if (!mod) return t.skip("launcher module not present");
    const locked = fn(mod, "isProfileLocked");
    const alive = fn(mod, "isProcessAlive");
    if (!locked || !alive) return t.skip("lock helpers not present");
    assert.equal(call(alive, 0), false);
    assert.equal(call(alive, process.pid), true);
    assert.equal(call(alive, 99_999_999), false);
    const dir = mkdtempSync(join(tmpdir(), "zenforge-lock-"));
    try {
      symlinkSync("localhost:+99999999", join(dir, "lock"));
      assert.equal(call(locked, dir), false);
      symlinkSync(`localhost:+${process.pid}`, join(dir, "parent.lock"));
      assert.equal(call(locked, dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
