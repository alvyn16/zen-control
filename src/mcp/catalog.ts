import { TOOL_DESCRIPTIONS } from "./descriptions.js";

/** Discovery groups shared by the documentation and the capability resource. */
export type ToolCategory =
  | "browser"
  | "spaces"
  | "tabs"
  | "reading"
  | "evidence"
  | "interaction"
  | "layout"
  | "organization"
  | "history"
  | "coordination"
  | "sessions"
  | "templates"
  | "discovery";

/** Ordered by breadth: every surface contains the one before it. */
export type ToolSurface = "research" | "core" | "full";

export const TOOL_SURFACES: readonly ToolSurface[] = ["research", "core", "full"];

export interface ToolMeta {
  name: string;
  category: ToolCategory;
  surfaces: readonly ToolSurface[];
}

/**
 * Research is the default: orient, open sources in the background, read and
 * search them, verify quotes, and hand the result back.
 */
const RESEARCH_TOOLS = [
  "zen_status",
  "zen_spaces_list",
  "zen_space_create",
  "zen_tabs_list",
  "zen_tabs_open",
  "zen_read_page",
  "zen_read_pages",
  "zen_find_text",
  "zen_search_tabs",
  "zen_show_evidence",
  "zen_show_evidence_batch",
  "zen_progress",
  "zen_events",
  "zen_config",
  "zen_notify",
  "zen_tools_search",
  "zen_tools_use",
] as const;

/** Core adds page interaction, workspace layout and tab organization. */
const CORE_TOOLS = [
  "zen_ask",
  "zen_answers",
  "zen_launch",
  "zen_space_switch",
  "zen_tabs_close",
  "zen_tab_select",
  "zen_glance",
  "zen_split_view",
  "zen_split_close",
  "zen_pin_tabs",
  "zen_essentials",
  "zen_containers_list",
  "zen_folders_list",
  "zen_folder_create",
  "zen_folder_add_tabs",
  "zen_click",
  "zen_type",
  "zen_wait_for",
  "zen_clear_evidence",
  "zen_tabs_audit",
  "zen_tabs_group",
] as const;

/** Full adds the long tail: history, monitoring, persistence and deletion. */
const FULL_TOOLS = [
  "zen_space_delete",
  "zen_history_search",
  "zen_history_recently_closed",
  "zen_bookmarks_search",
  "zen_watch_add",
  "zen_watch_list",
  "zen_watch_remove",
  "zen_clipboard_write",
  "zen_audit_tail",
  "zen_session_save",
  "zen_session_list",
  "zen_session_restore",
  "zen_session_delete",
  "zen_space_templates",
  "zen_template_apply",
  "zen_template_save",
  "zen_template_delete",
  "zen_doctor",
] as const;

const CATEGORIES: Record<string, ToolCategory> = {
  zen_status: "browser",
  zen_launch: "browser",
  zen_config: "browser",
  zen_audit_tail: "browser",
  zen_doctor: "browser",
  zen_spaces_list: "spaces",
  zen_space_create: "spaces",
  zen_space_switch: "spaces",
  zen_space_delete: "spaces",
  zen_tabs_list: "tabs",
  zen_tabs_open: "tabs",
  zen_tabs_close: "tabs",
  zen_tab_select: "tabs",
  zen_pin_tabs: "tabs",
  zen_essentials: "tabs",
  zen_read_page: "reading",
  zen_read_pages: "reading",
  zen_find_text: "reading",
  zen_search_tabs: "reading",
  zen_show_evidence: "evidence",
  zen_show_evidence_batch: "evidence",
  zen_clear_evidence: "evidence",
  zen_click: "interaction",
  zen_type: "interaction",
  zen_wait_for: "interaction",
  zen_glance: "layout",
  zen_split_view: "layout",
  zen_split_close: "layout",
  zen_containers_list: "organization",
  zen_folders_list: "organization",
  zen_folder_create: "organization",
  zen_folder_add_tabs: "organization",
  zen_tabs_audit: "organization",
  zen_tabs_group: "organization",
  zen_history_search: "history",
  zen_history_recently_closed: "history",
  zen_bookmarks_search: "history",
  zen_progress: "coordination",
  zen_events: "coordination",
  zen_ask: "coordination",
  zen_answers: "coordination",
  zen_notify: "coordination",
  zen_watch_add: "coordination",
  zen_watch_list: "coordination",
  zen_watch_remove: "coordination",
  zen_clipboard_write: "coordination",
  zen_session_save: "sessions",
  zen_session_list: "sessions",
  zen_session_restore: "sessions",
  zen_session_delete: "sessions",
  zen_space_templates: "templates",
  zen_template_apply: "templates",
  zen_template_save: "templates",
  zen_template_delete: "templates",
  zen_tools_search: "discovery",
  zen_tools_use: "discovery",
};

/** Stable aliases: better keyword recall without inflating every description. */
const KEYWORDS: Record<string, readonly string[]> = {
  zen_read_page: ["page", "extract", "content", "article", "text", "snapshot"],
  zen_read_pages: ["batch", "pages", "sources", "extract"],
  zen_find_text: ["find", "phrase", "occurrence", "grep"],
  zen_search_tabs: ["grep", "tabs", "mentions", "find"],
  zen_show_evidence: ["cite", "citation", "quote", "verify", "source"],
  zen_show_evidence_batch: ["cite", "citations", "batch", "verify"],
  zen_tabs_audit: ["duplicates", "stale", "cleanup", "triage"],
  zen_tabs_group: ["folders", "domains", "organize"],
  zen_folder_create: ["group", "folder", "organize"],
  zen_session_save: ["snapshot", "layout", "save"],
  zen_space_templates: ["template", "layout", "preset"],
  zen_watch_add: ["monitor", "change", "alert"],
  zen_tools_search: ["discover", "catalog", "capabilities", "help"],
  zen_tools_use: ["invoke", "gateway", "hidden", "publish"],
  zen_doctor: [
    "diagnostics", "diagnose", "doctor", "troubleshoot", "recover",
    "health", "preflight", "debug", "why failed", "repair",
  ],
};

export const ALL_TOOL_NAMES: readonly string[] = [
  ...RESEARCH_TOOLS,
  ...CORE_TOOLS,
  ...FULL_TOOLS,
];

const RESEARCH = new Set<string>(RESEARCH_TOOLS);
const CORE = new Set<string>(CORE_TOOLS);

function surfacesFor(name: string): readonly ToolSurface[] {
  if (RESEARCH.has(name)) return ["research", "core", "full"];
  if (CORE.has(name)) return ["core", "full"];
  return ["full"];
}

export const TOOL_META: Record<string, ToolMeta> = Object.fromEntries(
  ALL_TOOL_NAMES.map((name) => [
    name,
    { name, category: CATEGORIES[name] ?? "browser", surfaces: surfacesFor(name) },
  ])
);

const SURFACE_SETS: Record<ToolSurface, ReadonlySet<string>> = {
  research: new Set<string>(RESEARCH_TOOLS),
  core: new Set<string>([...RESEARCH_TOOLS, ...CORE_TOOLS]),
  full: new Set<string>(ALL_TOOL_NAMES),
};

export function toolsForSurface(surface: ToolSurface): ReadonlySet<string> {
  return SURFACE_SETS[surface] ?? SURFACE_SETS.research;
}

/** First paragraph, cut at a word boundary, for compact discovery results. */
export function summaryOf(name: string, maxChars = 220): string {
  const description = TOOL_DESCRIPTIONS[name] ?? "";
  const first = description.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (first.length <= maxChars) return first;
  const cut = first.slice(0, maxChars);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 60 ? cut.slice(0, boundary) : cut).trim()}...`;
}

export interface CatalogMatch extends ToolMeta {
  summary: string;
  keywords: readonly string[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Name matches outweigh body matches so "read" still finds zen_read_page. */
export function searchCatalog(
  query: string,
  options: { category?: string; limit?: number } = {}
): CatalogMatch[] {
  const limit = Math.max(1, Math.min(50, options.limit ?? 12));
  const terms = normalize(query).split(" ").filter(Boolean);
  const category = options.category?.trim().toLowerCase();
  const scored: Array<CatalogMatch & { score: number }> = [];

  for (const name of ALL_TOOL_NAMES) {
    const meta = TOOL_META[name];
    if (!meta || (category && meta.category !== category)) continue;
    const summary = summaryOf(name);
    const keywords = KEYWORDS[name] ?? [];
    const haystack = normalize([name, summary, meta.category, ...keywords].join(" "));
    let score = 0;
    if (terms.length === 0) {
      score = 1;
    } else {
      const toolName = normalize(name);
      if (toolName === terms.join(" ")) score += 100;
      if (terms.every((term) => toolName.includes(term))) score += 40;
      for (const term of terms) {
        if (toolName.includes(term)) score += 8;
        if (haystack.includes(term)) score += 3;
      }
    }
    if (score > 0) scored.push({ ...meta, summary, keywords, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ score: _score, ...match }) => match);
}

/** Startup invariant check: returns problems, empty means a consistent catalog. */
export function validateCatalog(): string[] {
  const problems: string[] = [];
  const known = new Set<string>();

  for (const name of ALL_TOOL_NAMES) {
    if (known.has(name)) problems.push(`duplicate tool name: ${name}`);
    known.add(name);
    if (!name.startsWith("zen_")) problems.push(`missing zen_ prefix: ${name}`);
    if (!TOOL_DESCRIPTIONS[name]) problems.push(`missing description: ${name}`);
    if (!CATEGORIES[name]) problems.push(`missing category: ${name}`);
    if (!TOOL_META[name]) problems.push(`missing metadata: ${name}`);
  }
  for (const name of Object.keys(TOOL_DESCRIPTIONS)) {
    if (!known.has(name)) problems.push(`description without a catalog entry: ${name}`);
  }

  // Surfaces must nest: research ⊂ core ⊂ full, with no stray memberships.
  for (const name of RESEARCH_TOOLS) {
    if (!SURFACE_SETS.core.has(name)) problems.push(`research tool missing from core: ${name}`);
    if (!SURFACE_SETS.full.has(name)) problems.push(`research tool missing from full: ${name}`);
  }
  for (const name of CORE_TOOLS) {
    if (!SURFACE_SETS.full.has(name)) problems.push(`core tool missing from full: ${name}`);
  }
  for (const name of RESEARCH_TOOLS) {
    const surfaces = TOOL_META[name]?.surfaces ?? [];
    if (surfaces.length !== 3 || surfaces[0] !== "research" || surfaces[2] !== "full") {
      problems.push(`unexpected surface list for research tool: ${name}`);
    }
  }
  for (const name of CORE_TOOLS) {
    const surfaces = TOOL_META[name]?.surfaces ?? [];
    if (surfaces.length !== 2 || surfaces[0] !== "core" || surfaces[1] !== "full") {
      problems.push(`unexpected surface list for core tool: ${name}`);
    }
  }
  for (const name of FULL_TOOLS) {
    const surfaces = TOOL_META[name]?.surfaces ?? [];
    if (surfaces.length !== 1 || surfaces[0] !== "full") {
      problems.push(`unexpected surface list for full-only tool: ${name}`);
    }
  }

  if (RESEARCH_TOOLS.length < 16 || RESEARCH_TOOLS.length > 19) {
    problems.push(
      `research surface has ${RESEARCH_TOOLS.length} tools; expected 16-19`
    );
  }
  for (const name of ALL_TOOL_NAMES) {
    const first = (TOOL_DESCRIPTIONS[name] ?? "").split(/\n\s*\n/)[0] ?? "";
    if (first.length > 400) {
      problems.push(`description first paragraph over 400 chars: ${name} (${first.length})`);
    }
  }
  return problems;
}
