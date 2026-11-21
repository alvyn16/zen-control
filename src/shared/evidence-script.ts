/**
 * Fixed browser scripts for Evidence Mode. Agents never supply JavaScript:
 * only a quote, offsets, a duration and a random marker are embedded as data.
 * The index and highlight scripts share the same walker so their offsets refer
 * to exactly the same characters.
 */

export interface EvidenceIndexOptions {
  maxChars?: number;
}

export interface EvidenceHighlightOptions {
  start: number;
  end: number;
  expectedText: string;
  ttlMs: number;
  scroll: boolean;
  marker: string;
  /** Markers from earlier successful highlights that must be removed first. */
  clearMarkers?: string[];
}

export interface EvidenceIndexSnapshot {
  title: string;
  url: string;
  readyState: string;
  contentType: string;
  text: string;
  truncated: boolean;
  textLength: number;
}

export interface EvidenceStateSnapshot {
  title: string;
  url: string;
  readyState: string;
  contentType: string;
}

export interface EvidenceHighlightReport {
  ok: boolean;
  stale: boolean;
  highlighted: boolean;
  scrolled: boolean;
  inView: boolean;
  rects: number;
  scrollY?: number;
  reason?: string;
}

export interface EvidenceClearReport {
  removed: number;
  cleared?: boolean;
}

const MARKER_PATTERN = /^data-[a-z0-9-]{8,}$/;

/** Creates a fresh, unguessable attribute name for one overlay host. */
export function createEvidenceMarker(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) throw new Error("No secure random source is available for evidence markers.");
  return `data-zen-${uuid.replace(/-/g, "")}`;
}

export function isEvidenceMarker(value: unknown): value is string {
  return typeof value === "string" && MARKER_PATTERN.test(value);
}

function asText(value: unknown, max: number): string {
  if (value === null || value === undefined) return "";
  return String(value).slice(0, max);
}

function wholeNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback;
}

/**
 * The one source of truth for "readable page text". It walks visible nodes in
 * document order, inserts newlines at block boundaries and records the raw
 * offset of every text node so a highlight can map back to a DOM Range.
 */
const WALKER_SOURCE = String.raw`
const MAX_COLLECT = 2000000;
const MAX_STEPS = 300000;
const SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, SVG:1, CANVAS:1,
  IFRAME:1, OBJECT:1, EMBED:1, TEXTAREA:1, SELECT:1, OPTION:1, INPUT:1,
  HEAD:1, META:1, LINK:1 };
const BLOCK = { ADDRESS:1, ARTICLE:1, ASIDE:1, BLOCKQUOTE:1, BODY:1, CAPTION:1,
  DD:1, DETAILS:1, DIALOG:1, DIV:1, DL:1, DT:1, FIELDSET:1, FIGCAPTION:1,
  FIGURE:1, FOOTER:1, FORM:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, HEADER:1,
  HGROUP:1, HR:1, LI:1, MAIN:1, NAV:1, OL:1, P:1, PRE:1, SECTION:1,
  SUMMARY:1, TABLE:1, TBODY:1, TD:1, TFOOT:1, TH:1, THEAD:1, TR:1, UL:1 };

function computed(element) {
  try {
    var view = document.defaultView;
    return view && view.getComputedStyle ? view.getComputedStyle(element) : null;
  } catch (error) {
    return null;
  }
}

function isHidden(element, style) {
  if (!element || !element.hasAttribute) return false;
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
  if (!style) return false;
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
  if (style.contentVisibility === "hidden") return true;
  if (parseFloat(style.opacity || "1") === 0) return true;
  if (style.fontSize && parseFloat(style.fontSize) === 0) return true;
  var color = String(style.color || "").replace(/\s+/g, "").toLowerCase();
  if (color === "transparent") return true;
  if (style.position === "absolute" || style.position === "fixed") {
    var rects = null;
    try { rects = element.getClientRects(); } catch (error) { return false; }
    if (!rects || rects.length === 0) return true;
  }
  return false;
}

function collectText(root) {
  var chunks = [];
  var nodes = [];
  var length = 0;
  var last = "";
  var capped = false;
  var steps = 0;

  function append(value) {
    chunks.push(value);
    length += value.length;
    last = value.charAt(value.length - 1);
  }
  function newline() {
    if (length === 0 || last === "\n") return;
    if (length >= MAX_COLLECT) { capped = true; return; }
    append("\n");
  }
  function addNode(node) {
    if (length >= MAX_COLLECT) { capped = true; return; }
    var value = node.nodeValue || "";
    if (!value) return;
    if (length + value.length > MAX_COLLECT) {
      value = value.slice(0, MAX_COLLECT - length);
      capped = true;
    }
    nodes.push({ node: node, start: length, end: length + value.length });
    append(value);
  }

  var stack = [{ node: root, br: false }];
  while (stack.length > 0 && !capped) {
    var frame = stack.pop();
    if (frame.br) { newline(); continue; }
    var node = frame.node;
    if (!node) continue;
    steps += 1;
    if (steps > MAX_STEPS) { capped = true; break; }
    if (node.nodeType === 3) { addNode(node); continue; }
    if (node.nodeType !== 1) continue;
    var tag = String(node.tagName || "").toUpperCase();
    if (SKIP[tag]) continue;
    if (tag === "BR") { newline(); continue; }
    var style = computed(node);
    if (isHidden(node, style)) continue;
    var display = style ? String(style.display || "") : "";
    var block = BLOCK[tag] === 1 || /^(block|flex|grid|list-item|table|flow-root)$/.test(display);
    if (block) { newline(); stack.push({ node: null, br: true }); }

    if (tag === "DETAILS" && !node.open) {
      var summary = null;
      for (var child = node.firstElementChild; child; child = child.nextElementSibling) {
        if (String(child.tagName || "").toUpperCase() === "SUMMARY") { summary = child; break; }
      }
      if (summary) stack.push({ node: summary, br: false });
      continue;
    }
    var children = [];
    for (var walker = node.firstChild; walker; walker = walker.nextSibling) children.push(walker);
    for (var index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], br: false });
    }
  }
  return { text: chunks.join(""), nodes: nodes, truncated: capped };
}

function dropMarkers(markers) {
  var removed = 0;
  for (var m = 0; m < markers.length; m += 1) {
    var found = document.querySelectorAll("[" + markers[m] + "]");
    for (var i = found.length - 1; i >= 0; i -= 1) {
      if (found[i] && found[i].parentNode) {
        found[i].parentNode.removeChild(found[i]);
        removed += 1;
      }
    }
  }
  return removed;
}
`;

/** Lightweight readiness probe, safe to run while a tab is still loading. */
export function buildEvidenceStateScript(): string {
  return String.raw`
return {
  title: String(document.title || "").slice(0, 1000),
  url: String(location.href || "").slice(0, 8000),
  readyState: String(document.readyState || "").slice(0, 40),
  contentType: String(document.contentType || "").slice(0, 200)
};
`;
}

/** Returns readable text plus a bounded snapshot of page metadata. */
export function buildEvidenceIndexScript(options: EvidenceIndexOptions = {}): string {
  const requested = Number(options?.maxChars);
  const maxChars = Number.isFinite(requested)
    ? Math.max(1_000, Math.min(1_000_000, Math.trunc(requested)))
    : 500_000;
  return String.raw`
const maxChars = ${JSON.stringify(maxChars)};
${WALKER_SOURCE}
const collected = collectText(document.body || document.documentElement);
var text = collected.text;
var truncated = collected.truncated;
if (text.length > maxChars) {
  text = text.slice(0, maxChars);
  truncated = true;
}
return {
  title: String(document.title || "").slice(0, 1000),
  url: String(location.href || "").slice(0, 8000),
  readyState: String(document.readyState || "").slice(0, 40),
  contentType: String(document.contentType || "").slice(0, 200),
  text: text,
  truncated: truncated,
  textLength: text.length
};
`;
}

function emptyReport(reason: string, stale: boolean, scrollY = 0): EvidenceHighlightReport {
  return {
    ok: false,
    stale,
    highlighted: false,
    scrolled: false,
    inView: false,
    rects: 0,
    scrollY,
    reason,
  };
}

/**
 * Re-walks the page, verifies the raw slice at the supplied offsets, then
 * paints inert boxes inside a closed shadow root. The page's own text, styles
 * and DOM are never modified apart from the temporary overlay host.
 */
export function buildEvidenceHighlightScript(options: EvidenceHighlightOptions): string {
  const start = wholeNumber(options?.start, 0);
  const end = Math.max(start, wholeNumber(options?.end, start));
  const expectedText = typeof options?.expectedText === "string" ? options.expectedText : "";
  const ttlMs = Number.isFinite(Number(options?.ttlMs))
    ? Math.max(1_000, Math.min(120_000, Math.trunc(Number(options.ttlMs))))
    : 20_000;
  const scroll = options?.scroll !== false;
  const marker = options?.marker;
  if (!isEvidenceMarker(marker)) {
    throw new Error("buildEvidenceHighlightScript requires a valid random marker.");
  }
  const clearMarkers = (Array.isArray(options?.clearMarkers) ? options.clearMarkers : [])
    .filter((entry): entry is string => isEvidenceMarker(entry));
  if (clearMarkers.indexOf(marker) < 0) clearMarkers.push(marker);

  return String.raw`
const start = ${JSON.stringify(start)};
const end = ${JSON.stringify(end)};
const expectedText = ${JSON.stringify(expectedText)};
const ttlMs = ${JSON.stringify(ttlMs)};
const shouldScroll = ${JSON.stringify(scroll)};
const marker = ${JSON.stringify(marker)};
const clearMarkers = ${JSON.stringify(clearMarkers)};
${WALKER_SOURCE}

var scrollY = Number(window.scrollY) || 0;
const collected = collectText(document.body || document.documentElement);
if (end > collected.text.length || collected.text.slice(start, end) !== expectedText) {
  return ${JSON.stringify(emptyReport("stale", true, 0))};
}

var first = -1;
var last = -1;
for (var i = 0; i < collected.nodes.length; i += 1) {
  var entry = collected.nodes[i];
  if (entry.end <= start) continue;
  if (entry.start >= end) break;
  if (first < 0) first = i;
  last = i;
}
if (first < 0 || last < 0) return ${JSON.stringify(emptyReport("no_text", false, 0))};

var firstEntry = collected.nodes[first];
var lastEntry = collected.nodes[last];
var range = document.createRange();
range.setStart(firstEntry.node, Math.max(0, start - firstEntry.start));
range.setEnd(lastEntry.node, Math.min(lastEntry.end - lastEntry.start, end - lastEntry.start));

if (shouldScroll) {
  var container = range.startContainer;
  var element = container && container.nodeType === 3 ? container.parentElement : container;
  if (element && element.scrollIntoView) {
    try { element.scrollIntoView({ block: "center", inline: "nearest" }); }
    catch (error) { try { element.scrollIntoView(); } catch (fallback) {} }
  }
}

var rects = [];
try { rects = Array.prototype.slice.call(range.getClientRects()); } catch (error) { rects = []; }
var viewportWidth = Number(window.innerWidth) || 0;
var viewportHeight = Number(window.innerHeight) || 0;
var inView = false;
for (var r = 0; r < rects.length; r += 1) {
  var rect = rects[r];
  if (rect.width <= 0 || rect.height <= 0) continue;
  if (rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth) {
    inView = true;
    break;
  }
}

dropMarkers(clearMarkers.concat([marker]));
var scrollX = Number(window.scrollX) || 0;
scrollY = Number(window.scrollY) || 0;
var layer = document.createElement("div");
layer.setAttribute(marker, "layer");
layer.setAttribute("aria-hidden", "true");
layer.style.cssText = "all:initial !important;position:absolute !important;left:0 !important;" +
  "top:0 !important;width:0 !important;height:0 !important;margin:0 !important;" +
  "padding:0 !important;border:0 !important;pointer-events:none !important;" +
  "z-index:2147483647 !important;display:block !important;";

var paintRoot = layer;
try {
  if (layer.attachShadow) paintRoot = layer.attachShadow({ mode: "closed" });
} catch (error) {
  paintRoot = layer;
}

var painted = 0;
for (var p = 0; p < rects.length && painted < 200; p += 1) {
  var boxRect = rects[p];
  if (boxRect.width <= 0 || boxRect.height <= 0) continue;
  var box = document.createElement("div");
  box.style.cssText = "position:absolute !important;box-sizing:border-box !important;" +
    "pointer-events:none !important;margin:0 !important;padding:0 !important;" +
    "border-radius:2px !important;background-color:rgba(255,214,64,0.42) !important;" +
    "box-shadow:0 0 0 2px rgba(206,132,0,0.62) !important;display:block !important;";
  box.style.left = boxRect.left + scrollX + "px";
  box.style.top = boxRect.top + scrollY + "px";
  box.style.width = boxRect.width + "px";
  box.style.height = boxRect.height + "px";
  paintRoot.appendChild(box);
  try {
    if (box.animate) {
      box.animate([{ opacity: 1 }, { opacity: 0 }], {
        delay: Math.max(0, ttlMs - 900),
        duration: Math.min(900, ttlMs),
        fill: "forwards"
      });
    }
  } catch (error) {}
  painted += 1;
}
if (painted === 0) return ${JSON.stringify(emptyReport("no_visible_rects", false, 0))};

(document.documentElement || document.body).appendChild(layer);
window.setTimeout(function () {
  if (layer.parentNode) layer.parentNode.removeChild(layer);
}, ttlMs);

return {
  ok: true,
  stale: false,
  highlighted: true,
  scrolled: shouldScroll ? inView : false,
  inView: inView,
  rects: painted,
  scrollY: scrollY,
  reason: ""
};
`;
}

/** Removes only overlay hosts carrying this bridge's random marker. */
export function buildEvidenceClearScript(marker: string): string {
  if (!isEvidenceMarker(marker)) {
    throw new Error("buildEvidenceClearScript requires a valid random marker.");
  }
  return String.raw`
const marker = ${JSON.stringify(marker)};
var removed = 0;
var found = document.querySelectorAll("[" + marker + "]");
for (var i = found.length - 1; i >= 0; i -= 1) {
  if (found[i] && found[i].parentNode) {
    found[i].parentNode.removeChild(found[i]);
    removed += 1;
  }
}
return { removed: removed, cleared: removed > 0 };
`;
}

export function coerceEvidenceIndex(raw: unknown): EvidenceIndexSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.text !== "string") return null;
  return {
    title: asText(value.title, 1_000),
    url: asText(value.url, 8_000),
    readyState: asText(value.readyState, 40),
    contentType: asText(value.contentType, 200),
    text: value.text.slice(0, 2_000_000),
    truncated: value.truncated === true,
    textLength: wholeNumber(value.textLength, value.text.length),
  };
}

export function coerceEvidenceState(raw: unknown): EvidenceStateSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    title: asText(value.title, 1_000),
    url: asText(value.url, 8_000),
    readyState: asText(value.readyState, 40),
    contentType: asText(value.contentType, 200),
  };
}

export function coerceEvidenceHighlight(raw: unknown): EvidenceHighlightReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false, stale: false, highlighted: false, scrolled: false,
      inView: false, rects: 0, reason: "no_result",
    };
  }
  const value = raw as Record<string, unknown>;
  const reason = typeof value.reason === "string" && value.reason
    ? value.reason.slice(0, 200)
    : undefined;
  return {
    ok: value.ok === true,
    stale: value.stale === true,
    highlighted: value.highlighted === true,
    scrolled: value.scrolled === true,
    inView: value.inView === true,
    rects: wholeNumber(value.rects, 0),
    scrollY: wholeNumber(value.scrollY, 0),
    ...(reason ? { reason } : {}),
  };
}

export function coerceEvidenceClear(raw: unknown): EvidenceClearReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { removed: 0, cleared: false };
  const value = raw as Record<string, unknown>;
  const removed = wholeNumber(value.removed, 0);
  return { removed, cleared: value.cleared === true };
}
