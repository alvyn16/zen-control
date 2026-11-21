import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isUrlAllowed, normalizeDomainList, normalizeWebUrl } from "../shared/url-policy.js";
import { ensurePrivateDir, PRIVATE_FILE_MODE } from "../utils/safe-file.js";

export type ToolGuardErrorCode = "read_only" | "domain_not_allowed" | "invalid_args";

export class ToolGuardError extends Error {
  readonly code: ToolGuardErrorCode;

  constructor(code: ToolGuardErrorCode, message: string) {
    super(message);
    this.name = "ToolGuardError";
    this.code = code;
  }
}

/** Tools that change browser, server, persisted or on-screen state. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "zen_launch",
  "zen_space_create",
  "zen_space_switch",
  "zen_space_delete",
  "zen_tabs_open",
  "zen_tabs_close",
  "zen_tab_select",
  "zen_folder_create",
  "zen_folder_add_tabs",
  "zen_pin_tabs",
  "zen_essentials",
  "zen_glance",
  "zen_split_view",
  "zen_split_close",
  "zen_clipboard_write",
  "zen_watch_add",
  "zen_watch_remove",
  "zen_session_save",
  "zen_session_restore",
  "zen_session_delete",
  "zen_template_save",
  "zen_template_delete",
  "zen_template_apply",
  "zen_tabs_group",
  "zen_click",
  "zen_type",
  "zen_show_evidence",
  "zen_show_evidence_batch",
  "zen_clear_evidence",
  "zen_progress",
  "zen_ask",
  "zen_notify",
]);

export type AuditOutcome = "success" | "partial" | "failed";

export interface AuditOutcomeFields {
  ok: boolean;
  executed: boolean;
  citationsVerified?: number;
  citationsFailed?: number;
  outcome?: AuditOutcome;
}

export interface AuditRecord extends AuditOutcomeFields {
  at: string;
  tool: string;
  durationMs: number;
  args?: unknown;
  urls?: string[];
  error?: { code?: string; message: string };
}

/**
 * Turns a handler result into audit flags without looking at page text or
 * quote content. Evidence batches additionally get citation counts and a
 * coarse outcome.
 */
export function auditOutcomeForResult(
  tool: string,
  value: unknown
): AuditOutcomeFields {
  const object = value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
  const declaredOk = object && typeof object.ok === "boolean" ? object.ok : true;
  const fields: AuditOutcomeFields = { ok: declaredOk, executed: true };
  if (!object) return fields;

  const numbers = [object.total, object.verified, object.failed];
  const batchShaped =
    tool === "zen_show_evidence_batch" || numbers.some((n) => n !== undefined);
  if (
    !batchShaped ||
    numbers.some(
      (n) => typeof n !== "number" || !Number.isFinite(n as number)
    )
  ) {
    return fields;
  }
  const verified = object.verified as number;
  const failed = object.failed as number;
  fields.citationsVerified = verified;
  fields.citationsFailed = failed;
  fields.outcome = fields.ok && failed === 0
    ? "success"
    : verified > 0
      ? "partial"
      : "failed";
  return fields;
}

const MAX_STRING = 500;
const MAX_ITEMS = 20;
const MAX_DEPTH = 3;
const MAX_ARGS_JSON = 2048;
const MAX_LOG_URLS = 30;
const MAX_URL_PATH = 300;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const TAIL_WINDOW_BYTES = 4 * 1024 * 1024;
const BACKUP_SUFFIX = ".1";

/** Keys whose values are user text or secrets; replaced by a length + digest. */
const SENSITIVE_KEYS = new Set([
  "answer", "citations", "claim", "context", "freeform", "options", "query",
  "question", "quote", "sourceTitle", "source_title", "target", "text",
]);

/** URLs reachable from arguments, normalized as the opener would normalize them. */
export function extractToolUrls(
  tool: string,
  args: Record<string, unknown> | undefined
): string[] {
  if (!args) return [];
  const found: string[] = [];
  const take = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const parsed = normalizeWebUrl(raw);
    found.push(parsed ? parsed.href : raw.trim());
  };

  if (tool === "zen_tabs_open") {
    const urls = args.urls;
    if (Array.isArray(urls)) urls.forEach(take);
    else take(urls);
  } else if (tool === "zen_glance" || tool === "zen_show_evidence") {
    take(args.url);
  } else if (tool === "zen_show_evidence_batch" && Array.isArray(args.citations)) {
    for (const citation of args.citations) {
      if (citation && typeof citation === "object") {
        take((citation as Record<string, unknown>).url);
      }
    }
  }
  return found;
}

export function auditFilePath(dataDir: string): string {
  return join(dataDir, "audit.jsonl");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stringifySafe(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "";
  }
}

function shortened(value: string): string {
  return value.length <= MAX_STRING
    ? value
    : `sha256:${digest(value)} (${value.length} chars)`;
}

function redacted(value: unknown, label: string): string {
  const text = stringifySafe(value);
  return `<redacted ${text.length} chars ${label}:${digest(text)}>`;
}

/** Scheme + host + path only: no userinfo, query string or fragment. */
export function redactUrlForAudit(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const candidates = /^[a-z][a-z0-9+.-]*:/i.test(value)
    ? [value]
    : [value, `https://${value}`];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return `${url.protocol.replace(/:$/, "")}:<redacted>`;
      }
      const path = url.pathname.length > MAX_URL_PATH
        ? `${url.pathname.slice(0, MAX_URL_PATH)}...`
        : url.pathname;
      return path && path !== "/"
        ? `${url.protocol}//${url.host}${path}`
        : `${url.protocol}//${url.host}`;
    } catch {
      // Try the next candidate.
    }
  }
  return `<unparseable url: ${value.length} chars>`;
}

function redactUrlsInText(text: string): string {
  return text.replace(
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi,
    (match) => redactUrlForAudit(match)
  );
}

function summarizeValue(value: unknown, depth: number, sensitive = false): unknown {
  if (value === null) return null;
  if (typeof value === "string") {
    return sensitive ? redacted(value, "sha256") : shortened(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (value instanceof Error) {
    return { name: value.name, message: shortened(value.message) };
  }
  if (depth >= MAX_DEPTH) return "[max depth]";
  if (sensitive) return redacted(value, "sha256");

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => summarizeValue(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`<${value.length - MAX_ITEMS} more>`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = redacted(entry, "sha256");
      continue;
    }
    let summarized: unknown;
    if ((key === "url" || key === "urlContains") && typeof entry === "string") {
      summarized = redactUrlForAudit(entry);
    } else if (key === "urls" && Array.isArray(entry)) {
      summarized = entry
        .slice(0, MAX_ITEMS)
        .map((item) => redactUrlForAudit(String(item)));
    } else {
      summarized = summarizeValue(entry, depth + 1);
    }
    if (summarized !== undefined) out[key] = summarized;
  }
  return out;
}

/** Bounded, redacted view of call arguments for the file audit log. */
export function summarizeArgs(args: unknown): unknown {
  if (args === undefined) return undefined;
  try {
    const value = summarizeValue(args, 0);
    const text = JSON.stringify(value);
    if (text !== undefined && text.length > MAX_ARGS_JSON) {
      return {
        truncated: true,
        size: text.length,
        preview: text.slice(0, MAX_ARGS_JSON - 96),
      };
    }
    return value;
  } catch {
    return { truncated: true, error: "unserializable arguments" };
  }
}

function messageOf(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

export class ToolGuard {
  readonly auditPath: string;
  private readonly readOnly: boolean;
  private readonly allowedDomains: string[];
  private readonly auditLog: boolean;
  private warned = false;

  constructor(options: {
    readOnly: boolean;
    allowedDomains: string[];
    auditLog: boolean;
    dataDir: string;
  }) {
    this.readOnly = options.readOnly;
    this.allowedDomains = [...(options.allowedDomains ?? [])];
    this.auditLog = options.auditLog;
    this.auditPath = auditFilePath(options.dataDir);
  }

  /** Throws on read-only violations or URLs outside the allowlist. */
  check(tool: string, args?: Record<string, unknown>, urls?: string[]): void {
    if (this.readOnly && MUTATING_TOOLS.has(tool)) {
      throw new ToolGuardError(
        "read_only",
        `Tool "${tool}" changes browser or server state and is disabled in ` +
          "read-only mode. Set readOnly to false to allow it."
      );
    }
    if (this.allowedDomains.length === 0) return;

    const list = normalizeDomainList(this.allowedDomains).join(", ") || "(none)";
    const candidates = urls ?? extractToolUrls(tool, args);
    for (const candidate of candidates) {
      const raw = String(candidate ?? "").trim();
      const parsed = normalizeWebUrl(raw);
      if (!parsed) {
        let scheme = "";
        try {
          scheme = new URL(raw).protocol;
        } catch {
          scheme = "";
        }
        const why = scheme
          ? `uses the "${scheme}" scheme, which is not http(s)`
          : "is not a valid http(s) URL";
        throw new ToolGuardError(
          "domain_not_allowed",
          `Blocked by domain allowlist: "${raw}" ${why} for "${tool}". Allowed domains: ${list}.`
        );
      }
      if (!isUrlAllowed(parsed.href, this.allowedDomains)) {
        throw new ToolGuardError(
          "domain_not_allowed",
          `Blocked by domain allowlist: domain "${parsed.hostname}" is not ` +
            `allowed for "${tool}". Allowed domains: ${list}.`
        );
      }
    }
  }

  /** Appends one JSON line. Never throws: one write failure is logged to stderr. */
  audit(record: AuditRecord): void {
    if (!this.auditLog) return;
    try {
      const line = serializeRecord(record);
      ensurePrivateDir(dirname(this.auditPath));
      this.rotateFor(Buffer.byteLength(line, "utf8"));
      appendFileSync(this.auditPath, line, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      });
      try {
        chmodSync(this.auditPath, PRIVATE_FILE_MODE);
      } catch {
        // Windows does not apply POSIX modes the same way.
      }
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.error(
          `zen-mcp: could not write the audit log at ${this.auditPath}: ${messageOf(error)}`
        );
      }
    }
  }

  /** Keeps one `.1` backup and the active file under 5 MB. */
  private rotateFor(incoming: number): void {
    try {
      const { size } = statSync(this.auditPath);
      if (size + incoming <= MAX_LOG_BYTES) return;
      const backup = `${this.auditPath}${BACKUP_SUFFIX}`;
      try {
        unlinkSync(backup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      renameSync(this.auditPath, backup);
      try {
        chmodSync(backup, PRIVATE_FILE_MODE);
      } catch {
        // Best effort where POSIX modes are unavailable.
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Last `limit` valid records, oldest first. Corrupt lines are skipped. */
  tail(limit = 50): AuditRecord[] {
    const capped = Math.max(0, Math.floor(limit));
    if (capped === 0 || !existsSync(this.auditPath)) return [];
    let text: string;
    try {
      const fd = openSync(this.auditPath, "r");
      try {
        const { size } = fstatSync(fd);
        const start = Math.max(0, size - TAIL_WINDOW_BYTES);
        const length = size - start;
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const count = readSync(fd, buffer, read, length - read, start + read);
          if (count <= 0) break;
          read += count;
        }
        text = buffer.subarray(0, read).toString("utf8");
        if (start > 0) {
          const boundary = text.indexOf("\n");
          text = boundary === -1 ? "" : text.slice(boundary + 1);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      return [];
    }
    const lines = text.split(/\r?\n/);
    const records: AuditRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && records.length < capped; i -= 1) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          parsed && typeof parsed === "object" &&
          typeof (parsed as AuditRecord).tool === "string" &&
          typeof (parsed as AuditRecord).at === "string"
        ) {
          records.push(parsed as AuditRecord);
        }
      } catch {
        // A damaged line does not spoil the rest of the tail.
      }
    }
    return records.reverse();
  }
}

/** Builds a bounded, redacted JSON line from an audit record. */
function serializeRecord(record: AuditRecord): string {
  const next: AuditRecord = { ...record };
  if (next.args !== undefined) next.args = summarizeArgs(next.args);
  if (next.urls !== undefined) {
    next.urls = [
      ...new Set(
        next.urls
          .slice(0, MAX_LOG_URLS)
          .map((url) => redactUrlForAudit(url))
          .filter(Boolean)
      ),
    ];
  }
  if (next.error) {
    next.error = {
      ...next.error,
      message: shortened(redactUrlsInText(next.error.message)),
    };
  }

  const line = `${JSON.stringify(next)}\n`;
  if (Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES) return line;

  return `${JSON.stringify({
    at: next.at,
    tool: next.tool,
    ok: next.ok,
    executed: next.executed,
    durationMs: next.durationMs,
    ...(next.citationsVerified !== undefined ? { citationsVerified: next.citationsVerified } : {}),
    ...(next.citationsFailed !== undefined ? { citationsFailed: next.citationsFailed } : {}),
    ...(next.outcome !== undefined ? { outcome: next.outcome } : {}),
    urls: next.urls,
    args: { truncated: true },
    ...(next.error ? { error: next.error } : {}),
  })}\n`;
}
