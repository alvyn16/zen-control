import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hostOf,
  isUrlAllowed,
  normalizeDomainEntry,
  normalizeDomainList,
  normalizeWebUrl,
} from "../../src/shared/url-policy.js";

describe("normalizeWebUrl", () => {
  it("adds an https scheme to bare hosts", () => {
    assert.equal(normalizeWebUrl("example.com/a")?.href, "https://example.com/a");
    assert.equal(normalizeWebUrl("  Example.COM  ")?.hostname, "example.com");
  });

  it("keeps http and https URLs intact", () => {
    assert.equal(normalizeWebUrl("http://localhost:8080/x")?.port, "8080");
    assert.equal(normalizeWebUrl("https://a.test/p?q=1")?.search, "?q=1");
  });

  it("rejects non-web schemes and empty input", () => {
    assert.equal(normalizeWebUrl("javascript:alert(1)"), null);
    assert.equal(normalizeWebUrl("file:///etc/passwd"), null);
    assert.equal(normalizeWebUrl("data:text/plain,hi"), null);
    assert.equal(normalizeWebUrl(""), null);
    assert.equal(normalizeWebUrl(null), null);
    assert.equal(normalizeWebUrl("   "), null);
  });

  it("rejects unparseable hosts", () => {
    assert.equal(normalizeWebUrl("https://"), null);
    assert.equal(normalizeWebUrl("http://[::1"), null);
  });
});

describe("domain normalization", () => {
  it("strips wildcards and stray dots and lowercases", () => {
    assert.equal(normalizeDomainEntry("*.Example.com"), "example.com");
    assert.equal(normalizeDomainEntry("...Docs.Org..."), "docs.org");
    assert.deepEqual(
      normalizeDomainList([" A.TEST ", "", "*.b.test"]),
      ["a.test", "b.test"]
    );
  });

  it("extracts a hostname with hostOf", () => {
    assert.equal(hostOf("https://WWW.Example.com:8443/a"), "www.example.com");
    assert.equal(hostOf("not a url"), null);
  });
});

describe("isUrlAllowed", () => {
  it("allows every http(s) URL when the list is empty", () => {
    assert.equal(isUrlAllowed("https://anything.test", []), true);
    assert.equal(isUrlAllowed("https://anything.test", undefined), true);
  });

  it("matches exact hosts and subdomains on a label boundary", () => {
    const domains = ["example.com"];
    assert.equal(isUrlAllowed("https://example.com", domains), true);
    assert.equal(isUrlAllowed("https://docs.example.com/a", domains), true);
    assert.equal(isUrlAllowed("http://a.b.example.com", domains), true);
    assert.equal(isUrlAllowed("https://notexample.com", domains), false);
    assert.equal(isUrlAllowed("https://example.com.evil.test", domains), false);
  });

  it("normalizes entries before matching", () => {
    assert.equal(isUrlAllowed("https://docs.example.com", ["*.Example.com"]), true);
  });

  it("denies non-web URLs and treats an all-dots entry as deny-all", () => {
    assert.equal(isUrlAllowed("javascript:alert(1)", ["example.com"]), false);
    assert.equal(isUrlAllowed("file:///etc/passwd", ["example.com"]), false);
    assert.equal(isUrlAllowed("https://example.com", ["..."]), false);
  });
});
