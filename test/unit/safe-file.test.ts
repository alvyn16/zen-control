import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  assertWritableTarget,
  atomicWritePrivate,
  ensurePrivateDir,
  readFileTextBounded,
} from "../../src/utils/safe-file.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zenforge-safe-file-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("atomicWritePrivate", () => {
  it("creates and replaces a file with owner-only permissions", () => {
    const target = join(tempDir, "nested", "config.json");
    atomicWritePrivate(target, '{"a":1}\n');
    assert.equal(readFileSync(target, "utf8"), '{"a":1}\n');

    atomicWritePrivate(target, '{"a":2}\n');
    assert.equal(readFileSync(target, "utf8"), '{"a":2}\n');

    if (process.platform !== "win32") {
      assert.equal(lstatSync(target).mode & 0o777, PRIVATE_FILE_MODE);
      assert.equal(lstatSync(join(tempDir, "nested")).mode & 0o777, PRIVATE_DIR_MODE);
    }
  });

  it("leaves no temporary files behind", () => {
    const target = join(tempDir, "clean.json");
    atomicWritePrivate(target, "ok");
    const entries = readdirSync(join(tempDir)).sort();
    assert.deepEqual(entries, ["clean.json"]);
  });

  it("refuses to write through a symlink", () => {
    const target = join(tempDir, "link.json");
    const victim = join(tempDir, "victim.json");
    writeFileSync(victim, "original");
    symlinkSync(victim, target);
    assert.throws(() => atomicWritePrivate(target, "pwned"), /Refusing to write through symlink/);
    assert.equal(readFileSync(victim, "utf8"), "original");
    assert.equal(readlinkSync(target), victim);
  });

  it("refuses to overwrite a directory", () => {
    const target = join(tempDir, "adir");
    mkdirSync(target);
    assert.throws(() => atomicWritePrivate(target, "x"), /Refusing to write non-regular file/);
  });

  it("assertWritableTarget ignores a missing path", () => {
    assert.doesNotThrow(() => assertWritableTarget(join(tempDir, "missing")));
  });
});

describe("ensurePrivateDir", () => {
  it("fixes the mode of an existing directory", () => {
    const dir = join(tempDir, "loose");
    mkdirSync(dir);
    if (process.platform !== "win32") chmodSync(dir, 0o777);
    ensurePrivateDir(dir);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(dir).mode & 0o777, PRIVATE_DIR_MODE);
    }
  });
});

describe("readFileTextBounded", () => {
  it("rejects oversized and non-regular files", () => {
    const target = join(tempDir, "big.txt");
    writeFileSync(target, "1234567890");
    assert.throws(() => readFileTextBounded(target, 5), /exceeds the 5-byte budget/);
    assert.throws(() => readFileTextBounded(tempDir, 100), /not a regular file/);
  });

  it("reads a regular file within budget", () => {
    const target = join(tempDir, "small.txt");
    writeFileSync(target, "hello");
    assert.equal(readFileTextBounded(target, 100), "hello");
  });
});
