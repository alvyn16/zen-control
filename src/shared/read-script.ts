/**
 * Generates the fixed, synchronous in-page scripts used by reads and actions,
 * plus the defensive Node-side coercers for everything they return. Options are
 * embedded as JSON data; no agent-supplied JavaScript is ever evaluated.
 */
import type {
  PageElement,
  PageHeading,
  PageLink,
  PageMetadata,
  PageReadResult,
  PageTable,
  ReadFormat,
  SemanticPage,
} from "./protocol.js";
import type { PageControlSignature, PageSignature, PageTextSignature } from "./delta.js";
import {
  SEMANTIC_HEADING_CHARS,
  SEMANTIC_LABEL_CHARS,
  SEMANTIC_MAX_COLLECTIONS,
  SEMANTIC_MAX_CONTROLS,
  SEMANTIC_MAX_DEPTH,
  SEMANTIC_MAX_DIALOGS,
  SEMANTIC_MAX_HEADINGS,
  SEMANTIC_MAX_LIMITATIONS,
  SEMANTIC_MAX_NODES,
  SEMANTIC_MAX_REGIONS,
  SEMANTIC_MAX_SHADOW_ROOTS,
  SEMANTIC_MAX_SIGNALS,
  coerceSemanticPage,
  leanSemanticPage,
} from "./semantic.js";
import { SENSITIVE_AUTOCOMPLETE_SOURCE, SENSITIVE_HINT_SOURCE } from "./sensitive.js";
import {
  SNAPSHOT_HEADING_CHARS,
  SNAPSHOT_MAX_HEADINGS,
  SNAPSHOT_MAX_LIMITATIONS,
  SNAPSHOT_TEXT_CHARS,
  clampSnapshotElements,
} from "./snapshot.js";
import type { NormalizedTarget } from "./target.js";

export const READ_FORMATS: readonly ReadFormat[] = [
  "text", "markdown", "links", "tables", "metadata", "outline",
  "interactive", "snapshot", "semantic",
];
const MAX_TEXT = 200_000;
const MAX_SELECTED = 4_000;
const MAX_LINKS = 300;
const MAX_TABLES = 20;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 12;
const MAX_CELL = 300;
const MAX_HEADINGS = 200;
export const MAX_PAGE_ELEMENTS = 200;

const TARGET_MAX_NODES = 6_000;
const TARGET_MAX_SHADOW_ROOTS = 100;
const TARGET_MAX_DEPTH = 6;
const TARGET_MAX_MATCHES = 6;
const REF_PREFIX_PATTERN = /^(?:f[0-9]+(?:\.[0-9]+){0,2}-)?$/;

export interface ReadScriptParams {
  tabId?: string;
  maxChars?: number;
  offset?: number;
  format?: ReadFormat;
  selector?: string;
  maxElements?: number;
  framePath?: number[];
  refPrefix?: string;
  allowedDomains?: string[];
  snapshot?: boolean;
  semantic?: boolean;
}

/** Internal element shape: the WebElement handle never crosses the MCP boundary. */
export interface CoercedElement extends PageElement {
  element?: unknown;
  digest?: string;
}

export interface CoercedPageSnapshot {
  title: string;
  url: string;
  selectedText: string;
  text: string;
  fullLength: number;
  offset: number;
  readyState: string;
  description: string | null;
  format: ReadFormat;
  selector: string | null;
  selectorMatched: boolean;
  contentType: string;
  markdown?: string;
  links?: PageLink[];
  tables?: PageTable[];
  metadata?: PageMetadata;
  outline?: PageHeading[];
  outlineTruncated?: boolean;
  elements?: CoercedElement[];
  outlineAnchors?: CoercedElement[];
  elementsTruncated?: boolean;
  elementsTotal?: number;
  semantic?: SemanticPage;
  semanticAnchors?: CoercedElement[];
  limitations?: string[];
  snapshotComplete?: boolean;
  framesComplete?: boolean;
  root?: unknown;
  snapshotId?: string;
}

export interface PageRef {
  ref: string;
  tag: string;
  role: string;
  label: string;
  type: string | null;
  href: string | null;
  sensitive: boolean;
  element: unknown;
  digest?: string;
}

export interface CoercedPageSnapshotOutcome {
  result: PageReadResult;
  snapshotId: string;
  refs: PageRef[];
  root: unknown;
}

function asString(value: unknown, max: number): string {
  if (value === null || value === undefined) return "";
  return String(value).slice(0, max);
}

function asNullableString(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const result = asString(value, max);
  return result ? result : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return fallback;
}

function normalizeFormat(value: unknown): ReadFormat {
  return typeof value === "string" && (READ_FORMATS as readonly string[]).includes(value)
    ? (value as ReadFormat)
    : "text";
}

/**
 * Shared browser helpers for labels, roles, sensitivity and FNV digests. The
 * same blob is inlined into the read, target, signature, wait and type probes
 * so they describe controls identically.
 */
const ELEMENT_HELPERS = String.raw`
const HINT_RE = new RegExp(${JSON.stringify(SENSITIVE_HINT_SOURCE)}, "i");
const AUTOCOMPLETE_RE = new RegExp(${JSON.stringify(SENSITIVE_AUTOCOMPLETE_SOURCE)}, "i");
const CONTROL_SELECTOR = "a[href],button,input:not([type=hidden]),textarea,select," +
  "summary,[contenteditable=true],[tabindex],[role=button],[role=link]," +
  "[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem]," +
  "[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=textbox]," +
  "[role=searchbox],[role=combobox],[role=slider],[role=spinbutton]";

function fnv(value) {
  var hash = 2166136261;
  var text = String(value == null ? "" : value);
  for (var i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeText(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00a0]/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function elementText(el, max) {
  var text = "";
  try { text = el.innerText || el.textContent || ""; } catch (error) {}
  return normalizeText(text).replace(/\n+/g, " ").slice(0, max || 200);
}

function visible(el) {
  try {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    var view = el.ownerDocument && el.ownerDocument.defaultView;
    var style = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
    if (!style) return true;
    return !(style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse");
  } catch (error) {
    return false;
  }
}

function labelOf(el, tag, type) {
  var label = "";
  try {
    label = String(el.getAttribute("aria-label") || "");
    if (!label) {
      var ids = String(el.getAttribute("aria-labelledby") || "").split(/\s+/);
      var root = el.getRootNode ? el.getRootNode() : document;
      for (var i = 0; i < ids.length && i < 4; i += 1) {
        if (!ids[i]) continue;
        var peer = null;
        try { peer = root.getElementById ? root.getElementById(ids[i]) : null; } catch (error) {}
        if (!peer) { try { peer = document.getElementById(ids[i]); } catch (error2) {} }
        if (peer) label += " " + String(peer.innerText || peer.textContent || "");
      }
    }
  } catch (error) {}
  label = normalizeText(label);
  if (!label) {
    try {
      if (el.labels && el.labels.length) {
        var parts = [];
        for (var l = 0; l < el.labels.length && l < 3; l += 1) {
          parts.push(String(el.labels[l].innerText || el.labels[l].textContent || ""));
        }
        label = normalizeText(parts.join(" "));
      }
    } catch (error3) {}
  }
  if (!label) {
    if (tag === "input" && /^(submit|button|reset)$/.test(type || "")) {
      label = String(el.value || "");
    } else if (tag === "button" || tag === "a" || tag === "summary") {
      label = elementText(el, 200);
    }
  }
  if (!label) {
    label = String(el.getAttribute("placeholder") || "") ||
      String(el.getAttribute("title") || "") ||
      String(el.getAttribute("alt") || "") ||
      String(el.getAttribute("name") || "");
  }
  return normalizeText(label).slice(0, 200);
}

function roleOf(el, tag, type) {
  var explicit = "";
  try { explicit = String(el.getAttribute("role") || "").trim().toLowerCase(); } catch (error) {}
  if (explicit) return explicit;
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return el.multiple ? "listbox" : "combobox";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
    if (type === "search") return "searchbox";
    if (type === "number") return "spinbutton";
    return "textbox";
  }
  if (el.isContentEditable) return "textbox";
  return "generic";
}

function hrefOf(el) {
  try {
    var raw = el.getAttribute("href");
    if (!raw) return null;
    var url = new URL(raw, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch (error) {}
  return null;
}

function autocompleteOf(el) {
  try {
    var value = String(el.getAttribute("autocomplete") || "").trim().toLowerCase();
    return value ? value.slice(0, 120) : null;
  } catch (error) {
    return null;
  }
}

function formOf(el) {
  try {
    var form = el.form || (el.closest ? el.closest("form") : null);
    if (!form) return null;
    return String(form.getAttribute("id") || form.getAttribute("name") || "").trim().slice(0, 120) || null;
  } catch (error) {
    return null;
  }
}

function selectedOf(el, tag, type) {
  try {
    if (tag === "option") return !!el.selected;
    if (type === "checkbox" || type === "radio") return !!el.checked;
    var aria = el.getAttribute("aria-selected");
    if (aria === "true") return true;
    if (aria === "false") return false;
  } catch (error) {}
  return null;
}

function valuePresent(el, tag, type) {
  try {
    if (tag === "input" && type === "file") return !!(el.files && el.files.length);
    if (tag === "select" || tag === "textarea") return String(el.value == null ? "" : el.value).length > 0;
    if (tag === "input") {
      if (type === "checkbox" || type === "radio") return false;
      return String(el.value == null ? "" : el.value).length > 0;
    }
    if (el.isContentEditable) return normalizeText(el.textContent || "").length > 0;
  } catch (error) {}
  return false;
}

function sensitiveField(el, tag, type, labelText, autocomplete) {
  if (type === "password" || type === "file" || type === "email" || type === "tel") return true;
  if (autocomplete && AUTOCOMPLETE_RE.test(autocomplete)) return true;
  try {
    var mode = String(el.getAttribute("inputmode") || "").toLowerCase();
    if (mode === "email" || mode === "tel") return true;
  } catch (error) {}
  var haystack = [
    String(el.getAttribute("name") || ""), String(el.getAttribute("id") || ""),
    String(el.getAttribute("placeholder") || ""), String(labelText || "")
  ].join(" ");
  return HINT_RE.test(haystack);
}

function describe(el) {
  var tag = String(el.tagName || "").toLowerCase();
  var type = tag === "input" ? String(el.type || "text").toLowerCase() : null;
  var labelText = labelOf(el, tag, type);
  var autocomplete = autocompleteOf(el);
  var placeholder = null;
  try { placeholder = el.getAttribute("placeholder") || null; } catch (error) {}
  var editable = false;
  if (tag === "textarea") editable = true;
  else if (tag === "input") editable = !/^(button|submit|reset|checkbox|radio|range|file|image|color|hidden)$/.test(type || "");
  else if (el.isContentEditable) editable = true;
  var descriptor = {
    tag: tag,
    role: roleOf(el, tag, type),
    type: type,
    label: labelText,
    placeholder: placeholder,
    href: hrefOf(el),
    disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
    checked: type === "checkbox" || type === "radio" ? !!el.checked : null,
    readOnly: !!(el.readOnly || el.getAttribute("aria-readonly") === "true"),
    sensitive: sensitiveField(el, tag, type, labelText, autocomplete),
    editable: editable,
    valuePresent: valuePresent(el, tag, type),
    autocomplete: autocomplete,
    selected: selectedOf(el, tag, type),
    form: formOf(el),
    value: null
  };
  descriptor.digest = fnv([
    descriptor.tag, descriptor.role, descriptor.type || "", descriptor.label,
    descriptor.placeholder || "", descriptor.href || ""
  ].join("|"));
  return descriptor;
}
`;

/** Chooses the effective format from either the format string or the flags. */
function resolveFormat(params: ReadScriptParams): ReadFormat {
  if (params?.semantic === true) return "semantic";
  if (params?.snapshot === true) return "snapshot";
  return normalizeFormat(params?.format);
}

/**
 * The read engine. It is intentionally synchronous so it also works in a
 * background tab through the content actor.
 */
export function buildReadScript(params: ReadScriptParams = {}): string {
  const format = resolveFormat(params);
  const compact = format === "snapshot" || format === "semantic";
  const requestedMax = Number(params?.maxChars);
  const maxChars = compact
    ? SNAPSHOT_TEXT_CHARS
    : Number.isFinite(requestedMax) ? Math.max(0, Math.floor(requestedMax)) : 24_000;
  const requestedOffset = Number(params?.offset);
  const offset = compact
    ? 0
    : Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
  const requestedElements = clampSnapshotElements(params?.maxElements);
  const elementCap = format === "semantic"
    ? Math.min(SEMANTIC_MAX_CONTROLS, requestedElements)
    : compact ? requestedElements : MAX_PAGE_ELEMENTS;
  const outlineLimit = compact ? SNAPSHOT_MAX_HEADINGS : MAX_HEADINGS;
  const outlineChars = compact ? SNAPSHOT_HEADING_CHARS : 500;
  const selector = typeof params?.selector === "string" && params.selector.trim()
    ? params.selector.trim() : null;
  const refPrefix = typeof params?.refPrefix === "string" && REF_PREFIX_PATTERN.test(params.refPrefix)
    ? params.refPrefix : "";
  const framePath = Array.isArray(params?.framePath)
    ? params.framePath.slice(0, 3).map((value) => Math.max(0, Math.floor(Number(value) || 0)))
    : [];

  return String.raw`
const maxChars = ${JSON.stringify(maxChars)};
const offset = ${JSON.stringify(offset)};
const format = ${JSON.stringify(format)};
const selector = ${JSON.stringify(selector)};
const refPrefix = ${JSON.stringify(refPrefix)};
const framePath = ${JSON.stringify(framePath)};
const compact = ${JSON.stringify(compact)};
const privateView = ${JSON.stringify(compact)};
const MAX_ELEMENTS = ${JSON.stringify(elementCap)};
const OUTLINE_LIMIT = ${JSON.stringify(outlineLimit)};
const OUTLINE_CHARS = ${JSON.stringify(outlineChars)};
const SEM_REGIONS = ${JSON.stringify(SEMANTIC_MAX_REGIONS)};
const SEM_HEADINGS = ${JSON.stringify(SEMANTIC_MAX_HEADINGS)};
const SEM_COLLECTIONS = ${JSON.stringify(SEMANTIC_MAX_COLLECTIONS)};
const SEM_DIALOGS = ${JSON.stringify(SEMANTIC_MAX_DIALOGS)};
const SEM_SAMPLES = ${JSON.stringify(3)};
const SEM_SIGNALS = ${JSON.stringify(SEMANTIC_MAX_SIGNALS)};
const SEM_MAX_LIMITATIONS = ${JSON.stringify(SNAPSHOT_MAX_LIMITATIONS)};
const SEM_NODES = ${JSON.stringify(SEMANTIC_MAX_NODES)};
const SEM_SHADOW = ${JSON.stringify(SEMANTIC_MAX_SHADOW_ROOTS)};
const SEM_DEPTH = ${JSON.stringify(SEMANTIC_MAX_DEPTH)};
const SEM_LABEL_CHARS = ${JSON.stringify(SEMANTIC_LABEL_CHARS)};
const SEM_HEADING_CHARS = ${JSON.stringify(SEMANTIC_HEADING_CHARS)};
const FENCE = String.fromCharCode(96, 96, 96);
const BREAK = "\u0000";
${ELEMENT_HELPERS}

const SKIP_TAGS = { SCRIPT:1, STYLE:1, NOSCRIPT:1, SVG:1, NAV:1, FOOTER:1, ASIDE:1, TEMPLATE:1 };
const BLOCK_TAGS = { ADDRESS:1, ARTICLE:1, BLOCKQUOTE:1, BODY:1, DD:1, DIV:1, DL:1,
  DT:1, FIELDSET:1, FIGCAPTION:1, FIGURE:1, FORM:1, H1:1, H2:1, H3:1, H4:1, H5:1,
  H6:1, HEADER:1, HR:1, LI:1, MAIN:1, OL:1, P:1, PRE:1, SECTION:1, TABLE:1, UL:1 };

function safe(fn, fallback) {
  try { var value = fn(); return value === undefined || value === null ? fallback : value; }
  catch (error) { return fallback; }
}

function tidy(value) {
  return String(value == null ? "" : value)
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/ +/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function absoluteUrl(raw) {
  var value = String(raw == null ? "" : raw).trim();
  if (!value || value.charAt(0) === "#") return null;
  var lower = value.toLowerCase();
  if (lower.indexOf("javascript:") === 0 || lower.indexOf("data:") === 0 || lower.indexOf("vbscript:") === 0) return null;
  try {
    var url = new URL(value, location.href);
    var protocol = url.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") return url.href;
  } catch (error) {}
  return null;
}

function escapeInline(value) {
  var text = String(value == null ? "" : value);
  var out = "";
  var tick = String.fromCharCode(96);
  for (var i = 0; i < text.length; i += 1) {
    var ch = text.charAt(i);
    if (ch === "\\" || ch === tick || ch === "*" || ch === "_" || ch === "[" || ch === "]" || ch === "|") out += "\\" + ch;
    else if (ch === "\n" || ch === "\r") out += " ";
    else out += ch;
  }
  return out;
}

function inline(node) {
  var out = "";
  if (!node) return out;
  var kids = node.childNodes || [];
  for (var i = 0; i < kids.length; i += 1) {
    var child = kids[i];
    if (child.nodeType === 3) { out += escapeInline(String(child.nodeValue || "")); continue; }
    if (child.nodeType !== 1) continue;
    var tag = String(child.tagName || "").toUpperCase();
    if (SKIP_TAGS[tag]) continue;
    if (tag === "BR") { out += BREAK; continue; }
    if (tag === "IMG") {
      var src = absoluteUrl(child.getAttribute("src"));
      if (src) out += "![" + tidy(child.getAttribute("alt") || "") + "](" + src + ")";
      continue;
    }
    var inner = inline(child);
    if (tag === "A") {
      var href = absoluteUrl(child.getAttribute("href"));
      var text = tidy(inner);
      out += href ? "[" + (text || href) + "](" + href + ")" : text;
      continue;
    }
    if (tag === "STRONG" || tag === "B") { var bold = tidy(inner); if (bold) out += "**" + bold + "**"; continue; }
    if (tag === "EM" || tag === "I") { var em = tidy(inner); if (em) out += "*" + em + "*"; continue; }
    if (tag === "DEL" || tag === "S" || tag === "STRIKE") { var del = tidy(inner); if (del) out += "~~" + del + "~~"; continue; }
    if (tag === "CODE") {
      var tick2 = String.fromCharCode(96);
      var code = tidy(inner).split(tick2).join("'");
      if (code) out += tick2 + code + tick2;
      continue;
    }
    if (BLOCK_TAGS[tag]) out += " " + inner + " ";
    else out += inner;
  }
  return out;
}

function finishInline(value) {
  return tidy(value).split(BREAK).join("  \n");
}

function cellText(cell) {
  return normalizeText(String(cell.textContent || "")).replace(/\n+/g, " ").slice(0, 300);
}

function cellsOf(row) {
  var cells = [];
  var children = row.children || [];
  for (var i = 0; i < children.length; i += 1) {
    var tag = String(children[i].tagName || "").toUpperCase();
    if (tag === "TD" || tag === "TH") cells.push(children[i]);
  }
  return cells;
}

function tableData(table) {
  var caption = null;
  var cap = safe(function () { return table.querySelector("caption"); }, null);
  if (cap && (!cap.closest || cap.closest("table") === table)) {
    var capText = normalizeText(cap.textContent || "");
    if (capText) caption = capText.slice(0, 500);
  }
  var all = [];
  var rows = safe(function () { return table.querySelectorAll("tr"); }, []);
  for (var i = 0; i < rows.length; i += 1) {
    var owner = rows[i].closest ? rows[i].closest("table") : table;
    if (owner && owner !== table) continue;
    all.push(rows[i]);
  }
  if (!all.length) return null;
  var headerRow = null;
  for (var h = 0; h < all.length; h += 1) {
    var parent = all[h].parentNode;
    if (parent && String(parent.tagName || "").toUpperCase() === "THEAD") { headerRow = all[h]; break; }
  }
  if (!headerRow) {
    var first = cellsOf(all[0]);
    var allTh = first.length > 0;
    for (var f = 0; f < first.length; f += 1) {
      if (String(first[f].tagName || "").toUpperCase() !== "TH") allTh = false;
    }
    if (allTh) headerRow = all[0];
  }
  var headers = [];
  if (headerRow) {
    var headerCells = cellsOf(headerRow);
    for (var hc = 0; hc < headerCells.length && headers.length < 12; hc += 1) headers.push(cellText(headerCells[hc]));
  }
  var body = [];
  for (var r = 0; r < all.length && body.length < 100; r += 1) {
    if (all[r] === headerRow) continue;
    var cells = cellsOf(all[r]);
    if (!cells.length) continue;
    var values = [];
    for (var c = 0; c < cells.length && values.length < 12; c += 1) values.push(cellText(cells[c]));
    body.push(values);
  }
  if (!headers.length && !body.length) return null;
  var width = headers.length;
  for (var w = 0; w < body.length; w += 1) width = Math.max(width, body[w].length);
  width = Math.min(width, 12);
  while (headers.length < width) headers.push("");
  headers = headers.slice(0, width);
  var normalized = [];
  for (var b = 0; b < body.length; b += 1) {
    var line = body[b].slice(0, width);
    while (line.length < width) line.push("");
    normalized.push(line);
  }
  return { caption: caption, headers: headers, rows: normalized };
}

function pipe(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function tableMarkdown(data) {
  var lines = [];
  var header = [];
  for (var i = 0; i < data.headers.length; i += 1) header.push(pipe(data.headers[i]));
  lines.push("| " + header.join(" | ") + " |");
  var sep = [];
  for (var s = 0; s < header.length; s += 1) sep.push("---");
  lines.push("| " + sep.join(" | ") + " |");
  for (var r = 0; r < data.rows.length; r += 1) {
    var cells = [];
    for (var c = 0; c < data.rows[r].length; c += 1) cells.push(pipe(data.rows[r][c]));
    lines.push("| " + cells.join(" | ") + " |");
  }
  return lines.join("\n");
}

function renderBlocks(el, blocks) {
  var kids = el.childNodes || [];
  for (var i = 0; i < kids.length; i += 1) {
    var child = kids[i];
    if (child.nodeType === 3) {
      var text = finishInline(String(child.nodeValue || ""));
      if (text) blocks.push(text);
      continue;
    }
    if (child.nodeType !== 1) continue;
    var tag = String(child.tagName || "").toUpperCase();
    if (SKIP_TAGS[tag]) continue;
    if (tag === "TABLE") {
      var table = safe(function () { return tableData(child); }, null);
      if (table) blocks.push(tableMarkdown(table));
      continue;
    }
    if (/^H[1-6]$/.test(tag)) {
      var heading = tidy(inline(child));
      if (heading) blocks.push(new Array(Number(tag.charAt(1)) + 1).join("#") + " " + heading);
      continue;
    }
    if (tag === "PRE" || tag === "CODE") {
      var raw = String(child.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
      if (raw) {
        var language = String(child.className || "").match(/language-([a-z0-9+#-]+)/i);
        blocks.push(FENCE + (language ? language[1] : "") + "\n" + raw + "\n" + FENCE);
      }
      continue;
    }
    if (tag === "BLOCKQUOTE") {
      var quote = safe(function () { return buildMarkdown(child); }, "");
      if (quote) blocks.push(String(quote).split("\n").map(function (line) { return "> " + line; }).join("\n"));
      continue;
    }
    if (tag === "UL" || tag === "OL") {
      var ordered = tag === "OL";
      var items = [];
      var listChildren = child.children || [];
      for (var l = 0; l < listChildren.length; l += 1) {
        if (String(listChildren[l].tagName || "").toUpperCase() !== "LI") continue;
        var li = listChildren[l];
        var parts = [];
        var nested = safe(function () { return buildMarkdown(li); }, "");
        if (nested) parts.push(String(nested).replace(/\n+/g, " "));
        var label = finishInline(parts.join(" ")).replace(/\n+/g, " ");
        items.push((ordered ? (l + 1) + ". " : "- ") + label);
      }
      if (items.length) blocks.push(items.join("\n"));
      continue;
    }
    var inlineText = finishInline(inline(child));
    if (inlineText) blocks.push(inlineText);
  }
}

function buildMarkdown(root) {
  if (!root) return "";
  var blocks = [];
  renderBlocks(root, blocks);
  return blocks.join("\n\n");
}

function buildLinks(root) {
  var links = [];
  if (!root || !root.querySelectorAll) return links;
  var nodes = safe(function () { return root.querySelectorAll("a[href]"); }, []);
  for (var i = 0; i < nodes.length && links.length < 300; i += 1) {
    var url = absoluteUrl(nodes[i].getAttribute("href"));
    if (!url) continue;
    var label = elementText(nodes[i], 300) || url;
    links.push({ text: label, url: url });
  }
  return links;
}

function buildTables(root) {
  var tables = [];
  if (!root || !root.querySelectorAll) return tables;
  var nodes = safe(function () { return root.querySelectorAll("table"); }, []);
  for (var i = 0; i < nodes.length && tables.length < 20; i += 1) {
    var data = safe(function () { return tableData(nodes[i]); }, null);
    if (data) tables.push(data);
  }
  return tables;
}

function firstMeta(selector) {
  var meta = safe(function () { return document.querySelector(selector); }, null);
  return meta ? String(meta.getAttribute("content") || "").trim() : "";
}

function buildMetadata() {
  function allMeta(selector, key) {
    var out = {};
    var nodes = safe(function () { return document.querySelectorAll(selector); }, []);
    for (var i = 0; i < nodes.length && i < 40; i += 1) {
      var name = String(nodes[i].getAttribute(key) || "").toLowerCase();
      var value = String(nodes[i].getAttribute("content") || "").slice(0, 500);
      if (name && name !== "__proto__" && value) out[name] = value;
    }
    return out;
  }
  return {
    title: String(document.title || "").slice(0, 1000),
    description: firstMeta('meta[name="description"]') || firstMeta('meta[property="og:description"]') || null,
    canonical: (function () {
      var link = safe(function () { return document.querySelector('link[rel="canonical"]'); }, null);
      return link ? String(link.getAttribute("href") || "").slice(0, 8000) || null : null;
    })(),
    lang: String(document.documentElement && document.documentElement.lang || "").slice(0, 40) || null,
    author: firstMeta('meta[name="author"]') || null,
    published: firstMeta('meta[property="article:published_time"]') || firstMeta('meta[name="date"]') || null,
    siteName: firstMeta('meta[property="og:site_name"]') || null,
    image: firstMeta('meta[property="og:image"]') || null,
    og: allMeta('meta[property^="og:"]', "property"),
    twitter: allMeta('meta[name^="twitter:"]', "name")
  };
}

function buildOutline(root) {
  var headings = [];
  var total = 0;
  if (!root || !root.querySelectorAll) return { headings: headings, total: total };
  var nodes = safe(function () { return root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]"); }, []);
  for (var i = 0; i < nodes.length; i += 1) {
    var text = elementText(nodes[i], OUTLINE_CHARS);
    if (!text) continue;
    total += 1;
    if (headings.length < OUTLINE_LIMIT) {
      var level = Number(String(nodes[i].tagName || "").replace(/^H/i, "")) ||
        Number(nodes[i].getAttribute("aria-level")) || 2;
      headings.push({ level: Math.min(6, Math.max(1, level)), text: text });
    }
  }
  return { headings: headings, total: total };
}

function collectElements(root, cap) {
  var elements = [];
  var total = 0;
  var truncated = false;
  if (!root || !root.querySelectorAll) return { elements: elements, total: total, truncated: truncated };
  var visited = [];
  function visit(scope) {
    var all = safe(function () { return scope.querySelectorAll("*"); }, []);
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      var isControl = false;
      try { isControl = el.matches ? el.matches(CONTROL_SELECTOR) : false; } catch (error) {}
      if (isControl) {
        total += 1;
        if (!visible(el)) continue;
        if (elements.length >= cap) { truncated = true; continue; }
        var fields = describe(el);
        var ref = refPrefix + "e" + (elements.length + 1);
        var value = null;
        if (!privateView) {
          try {
            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
              value = String(el.value == null ? "" : el.value).slice(0, 300);
            } else if (el.isContentEditable) {
              value = normalizeText(el.textContent || "").slice(0, 300);
            }
          } catch (error2) {}
          if (fields.sensitive) value = null;
        }
        elements.push({
          ref: ref, tag: fields.tag, role: fields.role, type: fields.type,
          label: fields.label, value: value, placeholder: fields.placeholder,
          href: fields.href, disabled: fields.disabled, checked: fields.checked,
          readOnly: fields.readOnly, sensitive: fields.sensitive, editable: fields.editable,
          valuePresent: fields.valuePresent, autocomplete: fields.autocomplete,
          selected: fields.selected, form: fields.form, digest: fields.digest,
          element: el, framePath: framePath.slice()
        });
      }
      if (el.shadowRoot && visited.indexOf(el.shadowRoot) < 0) {
        visited.push(el.shadowRoot);
        visit(el.shadowRoot);
      }
    }
  }
  visit(root);
  return { elements: elements, total: total, truncated: truncated };
}

function semanticLabel(el, tag) {
  var aria = "";
  try { aria = normalizeText(String(el.getAttribute("aria-label") || "")).slice(0, SEM_LABEL_CHARS); } catch (error) {}
  if (aria) return { label: aria, source: "aria" };
  var html = "";
  try {
    var ids = String(el.getAttribute("aria-labelledby") || "").split(/\s+/);
    var root = el.getRootNode ? el.getRootNode() : document;
    for (var i = 0; i < ids.length && i < 4; i += 1) {
      var peer = root.getElementById ? root.getElementById(ids[i]) : null;
      if (peer) html += " " + String(peer.textContent || "");
    }
  } catch (error) {}
  html = normalizeText(html).slice(0, SEM_LABEL_CHARS);
  if (html) return { label: html, source: "aria" };
  var heading = safe(function () { return el.querySelector("h1,h2,h3,h4,h5,h6"); }, null);
  var headingText = heading ? elementText(heading, SEM_HEADING_CHARS) : "";
  if (headingText) return { label: headingText, source: "heading" };
  var native = normalizeText(String(el.getAttribute("title") || "")).slice(0, SEM_LABEL_CHARS);
  return { label: native, source: native ? "html" : "inferred" };
}

function buildSemantic(root, elementTotal, elementTruncated) {
  var regions = [], headings = [], collections = [], dialogs = [], anchors = [];
  var nodes = 0, shadowRoots = 0;
  var regionTruncated = false, headingTruncated = false, collectionTruncated = false;
  var nodeTruncated = false, shadowTruncated = false;
  var counts = { password:0, search:0, forms:0, articles:0, headings:0, code:0,
    tables:0, images:0, missingAlt:0, links:0, cards:0, prices:0, addToCart:0 };
  var anchorCounter = 0;
  var regionByElement = [];

  function parentElement(el) {
    try {
      var nodeRoot = el.getRootNode ? el.getRootNode() : document;
      if (nodeRoot && nodeRoot.host) return nodeRoot.host;
      return el.parentElement || el.parentNode || null;
    } catch (error) { return null; }
  }

  function nearestRegion(el) {
    var node = parentElement(el);
    var guard = 0;
    while (node && guard < 64) {
      guard += 1;
      for (var i = 0; i < regionByElement.length; i += 1) {
        if (regionByElement[i].el === node) return regionByElement[i].id;
      }
      node = parentElement(node);
    }
    return null;
  }

  function anchor(el) {
    anchorCounter += 1;
    var ref = refPrefix + "s" + anchorCounter;
    var fields = describe(el);
    anchors.push({
      ref: ref, tag: fields.tag, role: fields.role, type: fields.type,
      label: fields.label, value: null, placeholder: fields.placeholder,
      href: fields.href, disabled: fields.disabled, checked: fields.checked,
      readOnly: fields.readOnly, sensitive: fields.sensitive, editable: fields.editable,
      valuePresent: fields.valuePresent, digest: fields.digest, element: el,
      framePath: framePath.slice()
    });
    return ref;
  }

  function regionRole(el, tag, explicit) {
    if (explicit === "banner" || explicit === "navigation" || explicit === "main" ||
        explicit === "complementary" || explicit === "contentinfo" || explicit === "search" ||
        explicit === "dialog" || explicit === "table" || explicit === "list") return explicit;
    if (tag === "main") return "main";
    if (tag === "nav") return "navigation";
    if (tag === "form") return "form";
    if (tag === "article") return "article";
    if (tag === "table") return "table";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "dialog") return "dialog";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "aside") return "complementary";
    if (explicit === "region" || tag === "section") return "section";
    return null;
  }

  function repeated(el) {
    var parent = el.parentNode;
    if (!parent || !parent.children) return null;
    var peers = [];
    for (var i = 0; i < parent.children.length; i += 1) {
      var peer = parent.children[i];
      if (visible(peer) && String(peer.tagName || "").toUpperCase() === String(el.tagName || "").toUpperCase()) {
        peers.push(peer);
      }
    }
    if (peers.length < 3 || peers.indexOf(el) !== 0) return null;
    var rich = 0;
    for (var p = 0; p < peers.length; p += 1) {
      var text = elementText(peers[p], 200);
      if (text.length > 12 || peers[p].querySelectorAll("a,button,h1,h2,h3,h4,img").length > 0) rich += 1;
    }
    if (rich < 3) return null;
    var kind = "items";
    var links = 0;
    for (var l = 0; l < peers.length; l += 1) links += peers[l].querySelectorAll ? peers[l].querySelectorAll("a[href]").length : 0;
    if (links >= peers.length) kind = "links";
    else if (/\$|€|£|price/i.test(elementText(el, 300))) kind = "cards";
    else if (peers[0].querySelectorAll("h2,h3,h4,img").length > 0) kind = "cards";
    return { kind: kind, count: peers.length, peers: peers };
  }

  function consider(el) {
    var tag = String(el.tagName || "").toLowerCase();
    var type = tag === "input" ? String(el.type || "").toLowerCase() : "";
    var explicit = "";
    try { explicit = String(el.getAttribute("role") || "").trim().toLowerCase(); } catch (error) {}
    if (tag === "input" && type === "password") counts.password += 1;
    if ((tag === "input" && type === "search") || explicit === "searchbox") counts.search += 1;
    if (tag === "form") counts.forms += 1;
    if (tag === "article") counts.articles += 1;
    if (/^H[1-6]$/.test(tag) || explicit === "heading") {
      counts.headings += 1;
      var headingText = elementText(el, SEM_HEADING_CHARS);
      if (headingText && headings.length < SEM_HEADINGS) {
        var level = Number(tag.replace(/^H/i, "")) || Number(el.getAttribute("aria-level")) || 2;
        headings.push({ level: Math.min(6, Math.max(1, level)), text: headingText, ref: anchor(el) });
      } else if (headingText) headingTruncated = true;
    }
    if (tag === "pre" || tag === "code") counts.code += 1;
    if (tag === "table") counts.tables += 1;
    if (tag === "img") { counts.images += 1; if (!el.hasAttribute("alt")) counts.missingAlt += 1; }
    if (tag === "a" && el.hasAttribute("href")) counts.links += 1;
    if (tag === "button" || tag === "a") {
      var action = labelOf(el, tag, type);
      if (/add to (cart|bag|basket)|buy now/i.test(action)) counts.addToCart += 1;
    }
    var role = regionRole(el, tag, explicit);
    var items = repeated(el);
    if (items && items.kind === "cards") counts.cards += 1;
    if (items && items.kind === "cards" && /\$|€|£|price/i.test(elementText(el, 300))) counts.prices += 1;

    if (explicit === "dialog" || tag === "dialog") {
      if (dialogs.length < SEM_DIALOGS) {
        var dlgLabel = semanticLabel(el, tag);
        dialogs.push({ ref: anchor(el), label: dlgLabel.label || "dialog", modal: el.getAttribute("aria-modal") === "true" });
      }
    }

    if (role) {
      if (regions.length < SEM_REGIONS) {
        var info = semanticLabel(el, tag);
        var head = safe(function () { return el.querySelector("h1,h2,h3,h4,h5,h6"); }, null);
        var heading = head ? elementText(head, SEM_HEADING_CHARS) : null;
        var region = {
          id: "r" + (regions.length + 1), role: role,
          label: info.label || heading || null,
          labelSource: info.source, heading: heading,
          parent: nearestRegion(el), ref: anchor(el),
          controls: el.querySelectorAll ? el.querySelectorAll(CONTROL_SELECTOR).length : 0,
          links: el.querySelectorAll ? el.querySelectorAll("a[href]").length : 0,
          items: items ? items.count : null, itemKind: items ? items.kind : null
        };
        regions.push(region);
        regionByElement.push({ el: el, id: region.id });
      } else {
        regionTruncated = true;
      }
    }
    if (items) {
      if (collections.length < SEM_COLLECTIONS) {
        var owner = regions[regions.length - 1];
        var sample = [];
        for (var s = 0; s < items.peers.length && sample.length < SEM_SAMPLES; s += 1) {
          sample.push({ ref: anchor(items.peers[s]), label: elementText(items.peers[s], SEM_LABEL_CHARS) });
        }
        collections.push({
          regionId: owner ? owner.id : "r1",
          kind: items.kind, count: items.count, sample: sample
        });
      } else {
        collectionTruncated = true;
      }
    }
  }

  function walk(scope, depth) {
    var all = safe(function () { return scope.querySelectorAll("*"); }, []);
    for (var i = 0; i < all.length; i += 1) {
      nodes += 1;
      if (nodes > SEM_NODES) { nodeTruncated = true; return; }
      var el = all[i];
      if (!visible(el) || el.getAttribute("aria-hidden") === "true") continue;
      consider(el);
      if (el.shadowRoot) {
        if (depth < SEM_DEPTH && shadowRoots < SEM_SHADOW) { shadowRoots += 1; walk(el.shadowRoot, depth + 1); }
        else shadowTruncated = true;
      }
    }
  }
  if (root) { consider(root); walk(root, 0); }

  var scores = {};
  var signals = [];
  function add(kind, points, signal) {
    scores[kind] = (scores[kind] || 0) + points;
    if (signals.indexOf(signal) < 0) signals.push(signal);
  }
  if (counts.password > 0) add("login", 5, "password field");
  if (counts.search > 0) add("search-results", 2, "search control");
  if (counts.forms > 0) add("form", 2, "form landmark");
  if (counts.articles >= 3) add("discussion", 2, "repeated articles");
  if (counts.articles > 0 && counts.headings >= 3) add("article", 2, "article structure");
  if (counts.code >= 3) add("documentation", 3, "code blocks");
  if (counts.tables >= 2 && regions.length >= 4) add("dashboard", 2, "tables with landmarks");
  if (counts.cards > 0) add("listing", 2, "repeated cards");
  if (counts.cards > 0 && counts.prices > 0) add("product", 3, "price cards");
  if (counts.addToCart > 0) add("product", 4, "add-to-cart control");
  var results = false;
  for (var c = 0; c < collections.length; c += 1) {
    if (collections[c].kind === "cards" && counts.search > 0) results = true;
  }
  if (results) add("search-results", 3, "results collection");

  var priority = ["login", "search-results", "product", "documentation", "discussion", "dashboard", "article", "form", "listing"];
  var best = "generic", bestScore = 0, second = 0;
  for (var p = 0; p < priority.length; p += 1) {
    var score = scores[priority[p]] || 0;
    if (score > bestScore) { second = bestScore; bestScore = score; best = priority[p]; }
    else if (score > second) second = score;
  }
  if (bestScore < 2) best = "generic";
  var margin = Math.max(0, bestScore - second);
  var confidence = best === "generic" ? 0.35 : Math.min(0.95, 0.5 + 0.08 * bestScore + 0.04 * margin);
  if (best !== "generic" && margin < 2) confidence = Math.min(confidence, 0.6);

  var primary = null;
  var primaryRoles = ["main", "article", "search", "dialog", "form"];
  for (var pr = 0; pr < primaryRoles.length && !primary; pr += 1) {
    for (var rr = 0; rr < regions.length; rr += 1) {
      if (regions[rr].role === primaryRoles[pr]) { primary = regions[rr].id; break; }
    }
  }
  if (!primary && regions.length) primary = regions[0].id;

  var limitations = [];
  if (nodeTruncated) limitations.push("The semantic scan hit its node cap; later landmarks were not inspected.");
  if (shadowTruncated) limitations.push("The semantic scan hit its open shadow-root cap.");
  if (regionTruncated) limitations.push("The landmark list hit its cap.");
  if (headingTruncated) limitations.push("The heading list hit its cap.");
  if (collectionTruncated) limitations.push("The repeated-structure list hit its cap.");

  var model = {
    classification: best, confidence: Math.round(confidence * 100) / 100,
    signals: signals.slice(0, SEM_SIGNALS), primaryRegion: primary,
    regions: regions, headings: headings, collections: collections, dialogs: dialogs,
    coverage: {
      complete: !nodeTruncated && !shadowTruncated && !regionTruncated && !headingTruncated && !collectionTruncated && !elementTruncated,
      nodes: nodes, regions: regions.length, regionsTruncated: regionTruncated,
      controls: elementTotal || 0, links: counts.links, headings: counts.headings,
      tables: counts.tables, images: counts.images, missingAlt: counts.missingAlt,
      shadowRoots: shadowRoots
    },
    limitations: limitations.slice(0, SEM_MAX_LIMITATIONS)
  };
  return { model: model, anchors: anchors };
}

var selectorMatched = true;
var root = null;
try {
  if (selector) {
    root = document.querySelector(selector);
    if (!root) selectorMatched = false;
  } else if (format === "interactive" || format === "snapshot" || format === "semantic") {
    root = document.body;
  } else {
    root = document.querySelector("article, main, [role='main']");
  }
} catch (error) {
  root = null;
  selectorMatched = false;
}
if (!root) {
  if (selector) selectorMatched = false;
  else root = document.body;
}

var text = safe(function () {
  return normalizeText(root ? String(root.innerText || root.textContent || "") : "");
}, "");
var primaryLength = text.length;
var appliedOffset = 0;
if (format === "text" || format === "markdown") appliedOffset = Math.min(offset, primaryLength);
var visibleText = text.slice(appliedOffset, appliedOffset + maxChars);
if (format === "interactive") visibleText = "";

var out = {
  title: String(document.title || "").slice(0, 1000),
  url: String(location.href || "").slice(0, 8000),
  selectedText: "",
  text: visibleText,
  fullLength: format === "interactive" ? 0 : primaryLength,
  offset: format === "interactive" ? 0 : appliedOffset,
  readyState: String(document.readyState || "").slice(0, 40),
  description: firstMeta('meta[name="description"]') || firstMeta('meta[property="og:description"]') || null,
  format: format,
  selector: selector,
  selectorMatched: selectorMatched,
  contentType: String(document.contentType || "").slice(0, 200)
};

if (!privateView) {
  out.selectedText = safe(function () {
    return typeof window !== "undefined" && window.getSelection ? String(window.getSelection().toString() || "").slice(0, 4000) : "";
  }, "");
}

if (format === "markdown") {
  var rawMarkdown = safe(function () { return buildMarkdown(root); }, "");
  out.markdown = String(rawMarkdown).slice(appliedOffset, appliedOffset + maxChars);
} else if (format === "links") {
  out.links = safe(function () { return buildLinks(root); }, []);
} else if (format === "tables") {
  out.tables = safe(function () { return buildTables(root); }, []);
} else if (format === "metadata") {
  var metadata = safe(function () { return buildMetadata(); }, null);
  if (metadata) { out.metadata = metadata; out.description = metadata.description; }
} else if (format === "outline") {
  var outline = safe(function () { return buildOutline(root); }, { headings: [], total: 0 });
  out.outline = outline.headings;
  out.outlineTruncated = outline.total > outline.headings.length;
} else if (format === "interactive" || format === "snapshot" || format === "semantic") {
  var collected = safe(function () { return collectElements(root, MAX_ELEMENTS); }, null);
  if (collected) {
    out.elements = collected.elements;
    out.elementsTruncated = collected.truncated;
    out.elementsTotal = collected.total;
  }
  if (compact) {
    var compactOutline = safe(function () { return buildOutline(root); }, { headings: [], total: 0 });
    out.outline = compactOutline.headings;
    out.outlineTruncated = compactOutline.total > compactOutline.headings.length;
  }
  if (format === "semantic") {
    var semantic = safe(function () {
      return buildSemantic(root, collected ? collected.total : 0, collected ? collected.truncated : false);
    }, null);
    if (semantic) { out.semantic = semantic.model; out.semanticAnchors = semantic.anchors; }
  }
  out.root = safe(function () { return document.documentElement || null; }, null);
}

return out;
`;
}

/** Resolves exactly one semantic target inside the document and shadow roots. */
export function buildSemanticTargetScript(target: NormalizedTarget): string {
  const options = {
    kind: target.kind,
    role: target.kind === "role" ? target.role ?? "" : "",
    name: target.kind === "role" ? target.name ?? target.value ?? "" : "",
    match: target.kind === "role" || target.kind === "text" ? target.match : "exact",
    text: target.kind === "text" ? target.value ?? "" : "",
    label: target.kind === "label" ? target.value ?? "" : "",
    placeholder: target.kind === "placeholder" ? target.value ?? "" : "",
    selector: target.kind === "selector" ? target.value ?? "" : "",
    ref: target.kind === "ref" ? target.value ?? "" : "",
    maxCandidates: target.maxCandidates,
  };
  return String.raw`
const options = ${JSON.stringify(options)};
const MAX_NODES = ${TARGET_MAX_NODES};
const MAX_SHADOW = ${TARGET_MAX_SHADOW_ROOTS};
const MAX_DEPTH = ${TARGET_MAX_DEPTH};
const MAX_MATCHES = ${TARGET_MAX_MATCHES};
${ELEMENT_HELPERS}

function safe(fn, fallback) {
  try { return fn(); } catch (error) { return fallback; }
}

function fullText(el) {
  var text = "";
  try { text = el.innerText || el.textContent || ""; } catch (error) {}
  return normalizeText(text).replace(/\n+/g, " ").slice(0, 2000);
}

function associatedLabel(el) {
  var parts = [];
  try {
    var aria = String(el.getAttribute("aria-label") || "");
    if (aria) parts.push(aria);
    var ids = String(el.getAttribute("aria-labelledby") || "").split(/\s+/);
    var root = el.getRootNode ? el.getRootNode() : document;
    for (var i = 0; i < ids.length && i < 4; i += 1) {
      if (!ids[i]) continue;
      var peer = root.getElementById ? root.getElementById(ids[i]) : null;
      if (peer) parts.push(String(peer.textContent || ""));
    }
    if (!parts.length && el.labels && el.labels.length) {
      for (var l = 0; l < el.labels.length && l < 3; l += 1) parts.push(String(el.labels[l].textContent || ""));
    }
  } catch (error) {}
  return normalizeText(parts.join(" ")).slice(0, 200);
}

function compare(candidate, wanted, mode) {
  var haystack = normalizeText(candidate).toLowerCase();
  var needle = normalizeText(wanted).toLowerCase();
  if (!needle) return false;
  return mode === "contains" ? haystack.indexOf(needle) >= 0 : haystack === needle;
}

function descriptor(el) {
  var fields = describe(el);
  return {
    tag: fields.tag, role: fields.role, name: fields.label.slice(0, 120),
    label: fields.label, placeholder: fields.placeholder, type: fields.type,
    href: fields.href, disabled: fields.disabled, readOnly: fields.readOnly,
    editable: fields.editable, sensitive: fields.sensitive, visible: visible(el),
    valuePresent: fields.valuePresent, checked: fields.checked, selected: fields.selected
  };
}

function interactive(el, tag, role) {
  if (tag === "input" && String(el.type || "").toLowerCase() === "hidden") return false;
  if (tag === "a" && el.hasAttribute("href")) return true;
  if (["button", "summary", "select", "textarea", "input", "option"].indexOf(tag) >= 0) return true;
  if (el.isContentEditable) return true;
  return /^(button|link|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem|menuitemcheckbox|menuitemradio|tab|switch|slider|spinbutton|treeitem)$/.test(role);
}

function matches(el, tag, type, role) {
  if (options.kind === "role") return role === options.role && compare(labelOf(el, tag, type), options.name, options.match);
  if (options.kind === "text") return interactive(el, tag, role) && compare(fullText(el), options.text, options.match);
  if (options.kind === "label") return compare(associatedLabel(el), options.label, "exact");
  if (options.kind === "placeholder") {
    var placeholder = "";
    try { placeholder = String(el.getAttribute("placeholder") || ""); } catch (error) {}
    return compare(placeholder, options.placeholder, "exact");
  }
  return false;
}

function brief(d) {
  return { tag: d.tag, role: d.role, name: d.name, type: d.type,
    sensitive: d.sensitive, visible: d.visible, disabled: d.disabled };
}

var root = null;
try { root = document.documentElement || null; } catch (error) {}

if (options.kind === "selector") {
  var selected = [];
  try {
    var list = document.querySelectorAll(options.selector);
    for (var s = 0; s < list.length && s < MAX_MATCHES; s += 1) selected.push(list[s]);
  } catch (error2) {
    return { found: false, ambiguous: false, count: 0, truncated: false, invalidSelector: true };
  }
  if (selected.length === 1) {
    var one = descriptor(selected[0]);
    one.element = selected[0]; one.root = root; one.found = true;
    one.ambiguous = false; one.count = 1; one.truncated = false;
    return one;
  }
  var briefs = [];
  for (var b = 0; b < selected.length && b < options.maxCandidates; b += 1) briefs.push(brief(descriptor(selected[b])));
  return { found: selected.length > 0, ambiguous: selected.length > 1,
    count: selected.length, truncated: false, root: root, candidates: briefs };
}

if (options.kind === "ref") {
  var node = null;
  try { node = arguments.length ? arguments[0] : null; } catch (error3) {}
  if (!node) return { found: false, ambiguous: false, count: 0, truncated: false, root: root };
  var info = descriptor(node);
  info.element = node; info.root = root; info.found = true;
  info.ambiguous = false; info.count = 1; info.truncated = false;
  return info;
}

var found = [], nodes = 0, shadows = 0, truncated = false, stopped = false;
function scan(scope, depth) {
  var all = safe(function () { return scope.querySelectorAll("*"); }, []);
  for (var i = 0; i < all.length; i += 1) {
    if (stopped || truncated) return;
    nodes += 1;
    if (nodes > MAX_NODES) { truncated = true; return; }
    var el = all[i];
    var tag = String(el.tagName || "").toLowerCase();
    var type = tag === "input" ? String(el.type || "text").toLowerCase() : null;
    var role = roleOf(el, tag, type);
    if (matches(el, tag, type, role)) {
      found.push(el);
      if (found.length >= MAX_MATCHES) { stopped = true; return; }
    }
    if (el.shadowRoot && depth < MAX_DEPTH && shadows < MAX_SHADOW) {
      shadows += 1;
      scan(el.shadowRoot, depth + 1);
    }
  }
}
scan(document, 0);

if (found.length === 1 && !truncated) {
  var single = descriptor(found[0]);
  single.element = found[0]; single.root = root; single.found = true;
  single.ambiguous = false; single.count = 1; single.truncated = false;
  return single;
}
var candidateBriefs = [];
for (var k = 0; k < found.length && k < options.maxCandidates; k += 1) candidateBriefs.push(brief(descriptor(found[k])));
return { found: found.length > 0, ambiguous: found.length > 1, count: found.length,
  truncated: truncated, root: root, candidates: candidateBriefs };
`;
}

export interface SemanticTargetProbe {
  found: boolean;
  ambiguous?: boolean;
  count: number;
  truncated?: boolean;
  invalidSelector?: boolean;
  root?: unknown;
  element?: unknown;
  tag?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string | null;
  type?: string | null;
  sensitive?: boolean;
  visible?: boolean;
  disabled?: boolean;
  descriptor?: { tag: string; role: string; label: string; type: string | null; sensitive: boolean };
  candidates?: Array<{
    tag: string; role: string; name: string; type: string | null;
    sensitive: boolean; visible: boolean; disabled: boolean;
  }>;
}

/** Freshness probe for a stored element handle. */
export function buildInspectElementScript(): string {
  return String.raw`
${ELEMENT_HELPERS}
var element = arguments.length ? arguments[0] : null;
var root = null;
try { root = document.documentElement || null; } catch (error) {}
if (!element) return { found: false, root: root };
var fields = describe(element);
return {
  found: true, root: root, element: element, tag: fields.tag, role: fields.role,
  type: fields.type, label: fields.label, href: fields.href,
  disabled: fields.disabled, readOnly: fields.readOnly, sensitive: fields.sensitive,
  editable: fields.editable, visible: visible(element)
};
`;
}

export interface WaitProbeParams {
  selector?: string;
  state?: string;
  text?: string;
  urlContains?: string;
  titleContains?: string;
  condition: string;
}

export interface WaitProbe {
  url: string;
  title: string;
  readyState: string;
  matched: boolean;
}

/** Fixed probe for waits; returns only a boolean and location metadata. */
export function buildWaitProbeScript(params: WaitProbeParams): string {
  const selector = typeof params?.selector === "string" && params.selector.trim()
    ? params.selector.trim() : null;
  const text = typeof params?.text === "string" && params.text.trim() ? params.text.trim() : null;
  const urlContains = typeof params?.urlContains === "string" && params.urlContains.trim()
    ? params.urlContains.trim() : null;
  const titleContains = typeof params?.titleContains === "string" && params.titleContains.trim()
    ? params.titleContains.trim() : null;
  const state = params?.state === "visible" || params?.state === "enabled" ? params.state : "present";
  const condition = typeof params?.condition === "string" ? params.condition : "";
  return String.raw`
const selector = ${JSON.stringify(selector)};
const state = ${JSON.stringify(state)};
const text = ${JSON.stringify(text)};
const urlContains = ${JSON.stringify(urlContains)};
const titleContains = ${JSON.stringify(titleContains)};
const condition = ${JSON.stringify(condition)};
${ELEMENT_HELPERS}

function locationInfo() {
  return {
    url: safe(function () { return String(location.href || "").slice(0, 8000); }, ""),
    title: safe(function () { return String(document.title || "").slice(0, 1000); }, ""),
    readyState: safe(function () { return String(document.readyState || "").slice(0, 40); }, "")
  };
}

function safe(fn, fallback) {
  try { var value = fn(); return value == null ? fallback : value; }
  catch (error) { return fallback; }
}

var info = locationInfo();
var matched = false;
function checkSelector() {
  if (!selector) return false;
  var element = safe(function () { return document.querySelector(selector); }, null);
  if (!element) return false;
  if (state === "visible") return visible(element);
  if (state === "enabled") return !element.disabled && element.getAttribute("aria-disabled") !== "true";
  return true;
}
function checkText() {
  if (!text) return false;
  var body = safe(function () { return document.body; }, null);
  var haystack = body ? String(body.innerText || body.textContent || "") : "";
  return haystack.toLowerCase().indexOf(text.toLowerCase()) >= 0;
}
function checkUrl() {
  return urlContains ? info.url.toLowerCase().indexOf(urlContains.toLowerCase()) >= 0 : false;
}
function checkTitle() {
  return titleContains ? info.title.toLowerCase().indexOf(titleContains.toLowerCase()) >= 0 : false;
}

if (condition === "selector") matched = checkSelector();
else if (condition === "text") matched = checkText();
else if (condition === "urlContains") matched = checkUrl();
else if (condition === "titleContains") matched = checkTitle();
else matched = checkSelector() || checkText() || checkUrl() || checkTitle();

return { url: info.url, title: info.title, readyState: info.readyState, matched: matched };
`;
}

export function coerceWaitProbe(raw: unknown): WaitProbe | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.url !== "string") return null;
  return {
    url: value.url.slice(0, 8_000),
    title: asString(value.title, 1_000),
    readyState: asString(value.readyState, 40),
    matched: value.matched === true,
  };
}

export function coerceSemanticTarget(raw: unknown): SemanticTargetProbe | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.invalidSelector === true) {
    return {
      found: false, ambiguous: false, count: 0, truncated: false, invalidSelector: true,
    };
  }
  const probe: SemanticTargetProbe = {
    found: value.found === true,
    ambiguous: value.ambiguous === true,
    count: Math.max(0, Math.min(6, Math.trunc(Number(value.count) || 0))),
    truncated: value.truncated === true,
  };
  if (value.root) probe.root = value.root;
  if (value.element) probe.element = value.element;
  for (const key of ["tag", "role", "name", "label"] as const) {
    if (typeof value[key] === "string") probe[key] = (value[key] as string).slice(0, key === "name" || key === "label" ? 200 : 80);
  }
  probe.placeholder = typeof value.placeholder === "string" ? value.placeholder.slice(0, 200) : null;
  probe.type = typeof value.type === "string" ? value.type.slice(0, 40) : null;
  probe.sensitive = value.sensitive === true;
  probe.visible = value.visible === true;
  probe.disabled = value.disabled === true;
  if (probe.found === true && probe.tag) {
    probe.descriptor = {
      tag: probe.tag,
      role: probe.role ?? "",
      label: probe.label ?? "",
      type: probe.type ?? null,
      sensitive: probe.sensitive === true,
    };
  }
  if (Array.isArray(value.candidates)) {
    const candidates: NonNullable<SemanticTargetProbe["candidates"]> = [];
    for (const entry of value.candidates.slice(0, 5)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      candidates.push({
        tag: asString(item.tag, 40),
        role: asString(item.role, 80),
        name: asString(item.name, 120),
        type: typeof item.type === "string" ? item.type.slice(0, 40) : null,
        sensitive: item.sensitive === true,
        visible: item.visible === true,
        disabled: item.disabled === true,
      });
    }
    probe.candidates = candidates;
  }
  return probe;
}

/** Compares a typed value internally without ever returning it. */
export function buildVerifyTypedValueScript(expected: string, mode: "exact" | "suffix"): string {
  return String.raw`
${ELEMENT_HELPERS}
const expected = ${JSON.stringify(String(expected ?? ""))};
const mode = ${JSON.stringify(mode === "exact" ? "exact" : "suffix")};
var element = arguments.length ? arguments[0] : null;
if (!element) return { compared: false, matchesInput: null, sensitive: false };
var tag = String(element.tagName || "").toLowerCase();
var type = tag === "input" ? String(element.type || "text").toLowerCase() : null;
var fields = describe(element);
if (fields.sensitive || type === "password" || type === "file") {
  return { compared: false, matchesInput: null, sensitive: true };
}
var current = null;
if (tag === "input" || tag === "textarea" || tag === "select") current = String(element.value == null ? "" : element.value);
else if (element.isContentEditable) current = String(element.innerText || element.textContent || "");
if (current === null) return { compared: false, matchesInput: null, sensitive: false };
var matches = mode === "exact"
  ? current === expected
  : current.slice(Math.max(0, current.length - expected.length)) === expected;
return { compared: true, matchesInput: matches, sensitive: false };
`;
}

export interface TypedValueProbe {
  compared: boolean;
  matchesInput: boolean | null;
  sensitive: boolean;
}

export function coerceTypedValueProbe(raw: unknown): TypedValueProbe {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { compared: false, matchesInput: null, sensitive: false };
  }
  const value = raw as Record<string, unknown>;
  return {
    compared: value.compared === true,
    matchesInput: typeof value.matchesInput === "boolean" ? value.matchesInput : null,
    sensitive: value.sensitive === true,
  };
}

/** Bounded signature with FNV hashes of text and non-sensitive form values. */
export function buildPageSignatureScript(): string {
  return String.raw`
${ELEMENT_HELPERS}
var body = safe(function () { return document.body; }, null);
var rawText = body ? String(body.textContent || "") : "";
var values = [];
try {
  var inputs = document.querySelectorAll("input,textarea,select");
  for (var i = 0; i < inputs.length && i < 200; i += 1) {
    var control = inputs[i];
    var type = String(control.type || "").toLowerCase();
    if (type === "password" || type === "file") continue;
    values.push(String(control.name || control.id || "") + "=" + String(control.value == null ? "" : control.value));
  }
} catch (error) {}

function safe(fn, fallback) {
  try { var value = fn(); return value == null ? fallback : value; }
  catch (error) { return fallback; }
}

function keyOf(el, tag, type, fields) {
  return fnv([tag, type || "", String(el.id || ""), String(el.getAttribute("name") || ""),
    String(el.getAttribute("aria-label") || ""), String(el.getAttribute("placeholder") || ""),
    elementText(el, 120)].join("|"));
}

var controls = [];
try {
  var nodes = document.querySelectorAll(CONTROL_SELECTOR);
  var seen = {};
  for (var c = 0; c < nodes.length && controls.length < 120; c += 1) {
    var node = nodes[c];
    var nodeTag = String(node.tagName || "").toLowerCase();
    var nodeType = nodeTag === "input" ? String(node.type || "text").toLowerCase() : null;
    var fields = describe(node);
    var base = keyOf(node, nodeTag, nodeType, fields);
    seen[base] = (seen[base] || 0) + 1;
    controls.push({
      key: base + ":" + seen[base], role: fields.role,
      name: fields.label.slice(0, 120), type: nodeType,
      state: {
        visible: visible(node), disabled: fields.disabled, readOnly: fields.readOnly,
        checked: fields.checked === true, selected: fields.selected === true,
        valuePresent: fields.valuePresent
      }
    });
  }
} catch (error2) {}

var headings = [];
try {
  var headingNodes = document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]");
  var headingSeen = {};
  for (var h = 0; h < headingNodes.length && headings.length < 80; h += 1) {
    var heading = headingNodes[h];
    var text = elementText(heading, 160);
    if (!text) continue;
    var key = fnv(text);
    headingSeen[key] = (headingSeen[key] || 0) + 1;
    headings.push({ key: key + ":" + headingSeen[key], text: text });
  }
} catch (error3) {}

var alerts = [];
try {
  var alertNodes = document.querySelectorAll("[role=alert],[role=status],[aria-live]");
  var alertSeen = {};
  for (var a = 0; a < alertNodes.length && alerts.length < 20; a += 1) {
    var alert = alertNodes[a];
    if (alert.querySelector && alert.querySelector("[role=alert],[role=status],[aria-live]")) continue;
    var alertText = elementText(alert, 200);
    if (!alertText) continue;
    var alertKey = fnv(alertText);
    alertSeen[alertKey] = (alertSeen[alertKey] || 0) + 1;
    alerts.push({ key: alertKey + ":" + alertSeen[alertKey], text: alertText });
  }
} catch (error4) {}

return {
  url: safe(function () { return String(location.href || "").slice(0, 8000); }, ""),
  title: safe(function () { return String(document.title || "").slice(0, 1000); }, ""),
  readyState: safe(function () { return String(document.readyState || "").slice(0, 40); }, ""),
  textLength: rawText.length,
  textHash: fnv(rawText.slice(0, 100000)),
  elementCount: safe(function () { return document.querySelectorAll("*").length; }, 0),
  valueHash: fnv(values.join("\u0001")),
  root: safe(function () { return document.documentElement || null; }, null),
  controls: controls, headings: headings, alerts: alerts
};
`;
}

export function coercePageSignature(raw: unknown): PageSignature | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.url !== "string") return null;
  const number = (input: unknown): number => {
    const numeric = Number(input);
    return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
  };
  const controls: PageControlSignature[] = [];
  if (Array.isArray(value.controls)) {
    for (const entry of value.controls.slice(0, 120)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const state: Record<string, boolean> = {};
      if (item.state && typeof item.state === "object" && !Array.isArray(item.state)) {
        for (const [key, flag] of Object.entries(item.state as Record<string, unknown>)) {
          state[key] = flag === true;
        }
      }
      controls.push({
        key: asString(item.key, 80),
        role: asString(item.role, 80),
        name: asString(item.name, 120),
        type: typeof item.type === "string" ? item.type.slice(0, 40) : null,
        state,
      });
    }
  }
  const texts = (input: unknown, max: number): PageTextSignature[] => {
    const result: PageTextSignature[] = [];
    if (!Array.isArray(input)) return result;
    for (const entry of input.slice(0, max)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      result.push({ key: asString(item.key, 80), text: asString(item.text, 200) });
    }
    return result;
  };
  const signature: PageSignature = {
    url: value.url.slice(0, 8_000),
    title: asString(value.title, 1_000),
    readyState: asString(value.readyState, 40),
    textLength: number(value.textLength),
    textHash: number(value.textHash),
    elementCount: number(value.elementCount),
    valueHash: number(value.valueHash),
    controls,
    headings: texts(value.headings, 80),
    alerts: texts(value.alerts, 20),
  };
  if (value.root) signature.root = value.root;
  return signature;
}

function coerceRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return record;
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 40) break;
    const key = rawKey.toLowerCase();
    if (!key || key === "__proto__") continue;
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") continue;
    const text = String(rawValue).slice(0, 500);
    if (!text) continue;
    record[key] = text;
    count += 1;
  }
  return record;
}

function coerceLinks(value: unknown): PageLink[] {
  if (!Array.isArray(value)) return [];
  const links: PageLink[] = [];
  for (const entry of value.slice(0, MAX_LINKS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const url = asString(item.url, 8_000);
    if (!url) continue;
    links.push({ text: asString(item.text, MAX_CELL) || url, url });
  }
  return links;
}

function coerceTables(value: unknown): PageTable[] {
  if (!Array.isArray(value)) return [];
  const tables: PageTable[] = [];
  for (const entry of value.slice(0, MAX_TABLES)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const headers = Array.isArray(item.headers)
      ? item.headers.slice(0, MAX_TABLE_COLUMNS).map((cell) => asString(cell, MAX_CELL))
      : [];
    const rows = Array.isArray(item.rows)
      ? item.rows.slice(0, MAX_TABLE_ROWS).map((row) =>
          Array.isArray(row) ? row.slice(0, MAX_TABLE_COLUMNS).map((cell) => asString(cell, MAX_CELL)) : []
        )
      : [];
    tables.push({ caption: asNullableString(item.caption, 500), headers, rows });
  }
  return tables;
}

function coerceHeadings(value: unknown, limit: number, maxChars: number): PageHeading[] {
  if (!Array.isArray(value)) return [];
  const headings: PageHeading[] = [];
  for (const entry of value.slice(0, limit)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const text = asString(item.text, maxChars);
    if (!text) continue;
    const level = Number(item.level);
    if (!Number.isFinite(level)) continue;
    headings.push({ level: Math.min(6, Math.max(1, Math.floor(level))), text });
  }
  return headings;
}

function coerceElements(value: unknown): CoercedElement[] {
  if (!Array.isArray(value)) return [];
  const elements: CoercedElement[] = [];
  for (const entry of value.slice(0, MAX_PAGE_ELEMENTS)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const ref = asString(item.ref, 32);
    const tag = asString(item.tag, 40);
    if (!ref || !tag) continue;
    const element: CoercedElement = {
      ref,
      tag,
      role: asString(item.role, 80) || "generic",
      type: asNullableString(item.type, 40),
      label: asString(item.label, 300),
      value: asNullableString(item.value, 300),
      placeholder: asNullableString(item.placeholder, 300),
      href: asNullableString(item.href, 8_000),
      disabled: item.disabled === true,
      checked: typeof item.checked === "boolean" ? item.checked : null,
      readOnly: item.readOnly === true,
      sensitive: item.sensitive === true,
      editable: item.editable === true,
    };
    if (typeof item.valuePresent === "boolean") element.valuePresent = item.valuePresent;
    if (item.autocomplete !== undefined) element.autocomplete = asNullableString(item.autocomplete, 120);
    if (typeof item.selected === "boolean" || item.selected === null) element.selected = item.selected as boolean | null;
    if (item.form !== undefined) element.form = asNullableString(item.form, 120);
    if (typeof item.digest === "string") element.digest = item.digest.slice(0, 40);
    if (item.element !== undefined) element.element = item.element;
    if (Array.isArray(item.framePath)) {
      element.framePath = item.framePath.slice(0, 3).map((index) => Math.max(0, Math.floor(Number(index) || 0)));
    }
    if (item.frameUrl !== undefined) {
      element.frameUrl = item.frameUrl === null ? null : asString(item.frameUrl, 8_000);
    }
    elements.push(element);
  }
  return elements;
}

function coerceMetadata(value: unknown): PageMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  return {
    title: asString(item.title, 1_000),
    description: asNullableString(item.description, 2_000),
    canonical: asNullableString(item.canonical, 8_000),
    lang: asNullableString(item.lang, 40),
    author: asNullableString(item.author, 500),
    published: asNullableString(item.published, 100),
    siteName: asNullableString(item.siteName, 500),
    image: asNullableString(item.image, 8_000),
    og: coerceRecord(item.og),
    twitter: coerceRecord(item.twitter),
  };
}

function makeSnapshotId(value: unknown): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 80) return value;
  const uuid = globalThis.crypto?.randomUUID?.();
  return `snap-${uuid ?? Math.random().toString(36).slice(2)}`;
}

/** Defensively parses a read script result into the internal snapshot shape. */
export function coercePageSnapshot(raw: unknown): CoercedPageSnapshotOutcome | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.url !== "string") return null;

  const text = asString(value.text, MAX_TEXT);
  const numericLength = Number(value.fullLength);
  const fullLength = Number.isFinite(numericLength)
    ? Math.max(0, Math.floor(numericLength))
    : text.length;
  const numericOffset = Number(value.offset);
  const offset = Number.isFinite(numericOffset)
    ? Math.min(fullLength, Math.max(0, Math.floor(numericOffset)))
    : 0;
  const format = normalizeFormat(value.format);
  const compact = format === "snapshot" || format === "semantic";

  const snapshot: CoercedPageSnapshot = {
    title: asString(value.title, 1_000),
    url: value.url.slice(0, 8_000),
    selectedText: asString(value.selectedText, MAX_SELECTED),
    text,
    fullLength,
    offset,
    readyState: asString(value.readyState, 40),
    description: asNullableString(value.description, 2_000),
    format,
    selector: asNullableString(value.selector, 2_000),
    selectorMatched: value.selectorMatched === undefined ? false : value.selectorMatched === true,
    contentType: asString(value.contentType, 200),
  };
  if (typeof value.markdown === "string") snapshot.markdown = value.markdown.slice(0, MAX_TEXT);
  if (Array.isArray(value.links)) snapshot.links = coerceLinks(value.links);
  if (Array.isArray(value.tables)) snapshot.tables = coerceTables(value.tables);
  if (value.metadata !== undefined && value.metadata !== null) {
    const metadata = coerceMetadata(value.metadata);
    if (metadata) snapshot.metadata = metadata;
  }
  if (Array.isArray(value.outline)) {
    snapshot.outline = coerceHeadings(value.outline, MAX_HEADINGS, 500);
    snapshot.outlineTruncated = value.outlineTruncated === true;
  }
  if (Array.isArray(value.elements)) {
    const elements = coerceElements(value.elements);
    if (compact) for (const element of elements) element.value = null;
    snapshot.elements = elements;
    snapshot.elementsTruncated = value.elementsTruncated === true;
    const total = Number(value.elementsTotal);
    snapshot.elementsTotal = Number.isFinite(total)
      ? Math.max(0, Math.floor(total))
      : elements.length;
  }
  if (Array.isArray(value.semanticAnchors)) {
    const anchors = coerceElements(value.semanticAnchors);
    for (const anchor of anchors) anchor.value = null;
    snapshot.semanticAnchors = anchors;
  }
  if (value.semantic !== undefined && value.semantic !== null) {
    const semantic = coerceSemanticPage(value.semantic);
    if (semantic) snapshot.semantic = semantic;
  }
  if (typeof value.snapshotComplete === "boolean") snapshot.snapshotComplete = value.snapshotComplete;
  if (typeof value.framesComplete === "boolean") snapshot.framesComplete = value.framesComplete;
  if (Array.isArray(value.limitations)) {
    snapshot.limitations = value.limitations
      .slice(0, SNAPSHOT_MAX_LIMITATIONS)
      .map((limitation) => asString(limitation, 300))
      .filter(Boolean);
  }
  if (value.root !== undefined) snapshot.root = value.root;
  snapshot.snapshotId = makeSnapshotId(value.snapshotId);

  const refs: PageRef[] = [];
  for (const element of [...(snapshot.elements ?? []), ...(snapshot.semanticAnchors ?? [])]) {
    if (!element.element) continue;
    const ref: PageRef = {
      ref: element.ref,
      tag: element.tag,
      role: element.role,
      label: element.label,
      type: element.type,
      href: element.href,
      sensitive: element.sensitive,
      element: element.element,
    };
    if (element.digest) ref.digest = element.digest;
    refs.push(ref);
  }
  return {
    result: toPageReadResult(snapshot, {
      snapshotId: snapshot.snapshotId,
      offset: numericOffset,
    }),
    snapshotId: snapshot.snapshotId as string,
    refs,
    root: value.root ?? null,
  };
}

function joinLimitation(existing: string | undefined, addition: string): string {
  return existing ? `${existing} ${addition}` : addition;
}

/** Applies paging, format flags and limitations to a coerced snapshot. */
export function toPageReadResult(
  snapshot: CoercedPageSnapshot,
  options: { maxChars?: number; contentType?: string | null; offset?: number; snapshotId?: string } = {}
): PageReadResult {
  const format = normalizeFormat(snapshot.format);
  const isSnapshot = format === "snapshot";
  const isSemantic = format === "semantic";
  const compact = isSnapshot || isSemantic;
  const structured = format !== "text" && format !== "markdown";
  const limit = Number(options?.maxChars);
  const hasLimit = options?.maxChars !== undefined && Number.isFinite(limit);
  const maxChars = hasLimit ? Math.max(0, Math.floor(limit)) : null;

  const text = typeof snapshot.text === "string" ? snapshot.text : "";
  const fullLength = Number.isFinite(Number(snapshot.fullLength))
    ? Math.max(0, Math.floor(Number(snapshot.fullLength)))
    : text.length;
  const primary = format === "markdown" && typeof snapshot.markdown === "string"
    ? snapshot.markdown.length
    : text.length;
  const appliedOffset = structured
    ? 0
    : Math.min(fullLength, Math.max(0, Math.floor(Number(snapshot.offset) || 0)));
  const nextOffset = !structured && primary > 0 && appliedOffset + primary < fullLength
    ? appliedOffset + primary
    : null;
  const elementsTruncated = snapshot.elementsTruncated === true;
  const semanticTruncated = isSemantic &&
    (snapshot.semantic?.coverage.regionsTruncated === true || snapshot.semantic?.coverage.complete === false);
  const textTruncated = compact && fullLength > text.length;
  const outlineTruncated = compact && snapshot.outlineTruncated === true;
  const truncated = compact
    ? textTruncated || elementsTruncated || outlineTruncated || Boolean(semanticTruncated)
    : (structured
        ? maxChars !== null ? fullLength > maxChars : fullLength > primary
        : nextOffset !== null) || elementsTruncated;
  const requestedOffset = Math.max(0, Math.floor(Number(options?.offset) || 0));

  const result: PageReadResult = {
    title: asString(snapshot.title, 1_000),
    url: asString(snapshot.url, 8_000),
    selectedText: !compact ? asString(snapshot.selectedText, MAX_SELECTED) : "",
    text,
    truncated,
    length: fullLength,
    offset: appliedOffset,
    nextOffset: isSnapshot ? null : nextOffset,
    description: snapshot.description ?? null,
    format,
    selector: snapshot.selector ?? null,
    contentType: options?.contentType !== undefined ? options.contentType : (snapshot.contentType || null),
  };
  if (typeof snapshot.markdown === "string") result.markdown = snapshot.markdown;
  if (Array.isArray(snapshot.links)) {
    result.links = snapshot.links.map((link) => ({ text: String(link.text ?? ""), url: String(link.url ?? "") }));
  }
  if (Array.isArray(snapshot.tables)) {
    result.tables = snapshot.tables.map((table) => ({
      caption: table.caption ?? null,
      headers: Array.isArray(table.headers) ? table.headers.map((cell) => String(cell ?? "")) : [],
      rows: Array.isArray(table.rows)
        ? table.rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []))
        : [],
    }));
  }
  if (snapshot.metadata) result.metadata = snapshot.metadata;

  if (compact) {
    if (!isSemantic) {
      result.outline = (snapshot.outline ?? []).map((heading) => ({
        level: Number(heading.level) || 1,
        text: String(heading.text ?? ""),
      }));
    }
  } else if (Array.isArray(snapshot.outline)) {
    result.outline = snapshot.outline.map((heading) => ({
      level: Number(heading.level) || 1,
      text: String(heading.text ?? ""),
    }));
  }

  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : null;
  if (elements) {
    result.elements = elements.map((element) => {
      const mapped: PageElement = {
        ref: String(element.ref ?? ""),
        tag: String(element.tag ?? ""),
        role: String(element.role ?? "generic"),
        type: element.type ?? null,
        label: String(element.label ?? ""),
        placeholder: element.placeholder ?? null,
        href: element.href ?? null,
        disabled: element.disabled === true,
        checked: typeof element.checked === "boolean" ? element.checked : null,
        readOnly: element.readOnly === true,
        sensitive: element.sensitive === true,
        editable: element.editable === true,
      };
      if (!compact) {
        mapped.value = element.value ?? null;
      } else {
        if (element.valuePresent === true) mapped.valuePresent = true;
        if (element.autocomplete) mapped.autocomplete = element.autocomplete;
        if (typeof element.selected === "boolean") mapped.selected = element.selected;
        if (element.form) mapped.form = element.form;
      }
      if (Array.isArray(element.framePath)) {
        mapped.framePath = element.framePath.map((index) => Math.max(0, Math.floor(Number(index) || 0)));
      }
      if (element.frameUrl !== undefined) mapped.frameUrl = element.frameUrl;
      return mapped;
    });
  } else if (compact) {
    result.elements = [];
  }
  if (elementsTruncated) result.elementsTruncated = true;
  if (isSemantic && snapshot.semantic) result.semantic = leanSemanticPage(snapshot.semantic);

  if (compact) {
    const limitations: string[] = [];
    if (Array.isArray(snapshot.limitations)) limitations.push(...snapshot.limitations);
    if (snapshot.selectorMatched === false) {
      limitations.push("The selector did not match any element (selector_not_found).");
    }
    if (textTruncated) {
      limitations.push(
        `Text preview is limited to ${SNAPSHOT_TEXT_CHARS} characters. Use format="text" with offset to page through the full text.`
      );
    }
    if (elementsTruncated) {
      limitations.push(format === "semantic"
        ? `The semantic control list is capped at ${SEMANTIC_MAX_CONTROLS} controls; narrow it with selector.`
        : "The snapshot control list reached its cap. Narrow it with selector or raise maxElements.");
    }
    if (outlineTruncated && !isSemantic) {
      limitations.push(`The snapshot outline is limited to ${SNAPSHOT_MAX_HEADINGS} headings.`);
    }
    if (requestedOffset > 0) {
      limitations.push(`offset is ignored for ${format} reads; the preview always starts at the beginning.`);
    }
    if (isSemantic && snapshot.semantic) limitations.push(...snapshot.semantic.limitations);
    result.snapshotId = options?.snapshotId ?? snapshot.snapshotId;
    result.elementsTotal = Number.isFinite(Number(snapshot.elementsTotal))
      ? Math.max(0, Math.floor(Number(snapshot.elementsTotal)))
      : (elements?.length ?? 0);
    result.elementsTruncated = elementsTruncated;
    result.textTruncated = textTruncated;
    if (!isSemantic) result.outlineTruncated = outlineTruncated;
    if (isSnapshot) {
      result.framesComplete = snapshot.framesComplete !== false;
      result.snapshotComplete = snapshot.snapshotComplete !== false;
    }
    result.limitations = Array.from(new Set(limitations)).slice(0, SNAPSHOT_MAX_LIMITATIONS);
    return result;
  }

  if (elementsTruncated) {
    result.limitation = joinLimitation(
      result.limitation,
      "The interactive scan reached its element cap. Narrow it with selector to see the rest."
    );
  }
  if (snapshot.selectorMatched === false) {
    result.limitation = joinLimitation(
      result.limitation,
      "The selector did not match any element (selector_not_found)."
    );
  }
  if (structured && requestedOffset > 0) {
    result.limitation = joinLimitation(
      result.limitation,
      `offset is only supported for text and markdown reads. This ${format} read ignored offset=${requestedOffset}.`
    );
  }
  return result;
}
