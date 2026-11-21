/**
 * Reusable space recipes. Built-ins ship with the harness; user templates are
 * stored as private, bounded JSON and validated on every read.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BridgeHub } from "../bridge/host.js";
import type {
  CreateFolderParams,
  CreateFolderResult,
  CreateSpaceParams,
  CreateSpaceResult,
  FoldersResult,
  OpenedTab,
  OpenTabsParams,
  OpenTabsResult,
  Space,
  SpacesResult,
  TabsListParams,
  TabsResult,
} from "../shared/protocol.js";
import { atomicWritePrivate, readFileTextBounded } from "../utils/safe-file.js";

const FILE_NAME = "templates.json";
const BATCH_SIZE = 30;
const MAX_NAME_LENGTH = 64;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_USER_TEMPLATES = 100;
const MAX_FOLDERS_PER_TEMPLATE = 100;
const MAX_URLS_PER_TEMPLATE = 2000;
const MAX_URL_LENGTH = 4096;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_ICON_LENGTH = 200;
const MAX_CREATED_AT_LENGTH = 64;

export interface SpaceTemplateFolder {
  label: string;
  urls: string[];
}

export interface SpaceTemplate {
  name: string;
  label: string;
  description: string;
  icon: string | null;
  builtIn: boolean;
  createdAt?: string;
  folders: SpaceTemplateFolder[];
  looseUrls: string[];
}

export interface SpaceTemplateApplyResult {
  template: string;
  space: Space;
  tabsOpened: number;
  foldersCreated: number;
  tabsFailed: number;
  warnings: string[];
}

/** Alias kept for callers that use the shorter name. */
export type TemplateApplyResult = SpaceTemplateApplyResult;

export interface TemplateSaveOptions {
  description?: string;
  icon?: string;
}

export interface TemplateApplyOptions {
  spaceName?: string;
  background?: boolean;
}

/** Only the hub operations a template needs. */
export interface TemplateHubLike {
  listSpaces(windowId?: string): Promise<SpacesResult>;
  listTabs(params: TabsListParams, windowId?: string): Promise<TabsResult>;
  listFolders(windowId?: string): Promise<FoldersResult>;
  createSpace(params: CreateSpaceParams, windowId?: string): Promise<CreateSpaceResult>;
  openTabs(params: OpenTabsParams, windowId?: string): Promise<OpenTabsResult>;
  createFolder(params: CreateFolderParams, windowId?: string): Promise<CreateFolderResult>;
}

export interface TemplateStoreOptions {
  dir: string;
  hub: BridgeHub;
}

interface TemplatesFile {
  version: 1;
  templates: SpaceTemplate[];
}

function builtIn(
  name: string,
  label: string,
  description: string,
  icon: string,
  folders: SpaceTemplateFolder[],
  looseUrls: string[]
): SpaceTemplate {
  return { name, label, description, icon, builtIn: true, folders, looseUrls };
}

export const BUILTIN_TEMPLATES: SpaceTemplate[] = [
  builtIn(
    "research",
    "Research",
    "Starting points for a literature scan: reference works, preprints and citation indexes.",
    "🔬",
    [
      {
        label: "Sources",
        urls: [
          "https://en.wikipedia.org",
          "https://arxiv.org",
          "https://scholar.google.com",
          "https://www.semanticscholar.org",
        ],
      },
    ],
    []
  ),
  builtIn(
    "github-triage",
    "GitHub Triage",
    "Notifications, pull requests, issues and workflow runs for the repositories you watch.",
    "🐙",
    [
      {
        label: "Review",
        urls: [
          "https://github.com/notifications",
          "https://github.com/pulls",
          "https://github.com/issues",
        ],
      },
      { label: "CI", urls: ["https://github.com/actions"] },
    ],
    []
  ),
  builtIn(
    "news",
    "News",
    "A quick briefing from a tech aggregator and several general news wires.",
    "📰",
    [],
    [
      "https://news.ycombinator.com",
      "https://www.reuters.com",
      "https://apnews.com",
      "https://www.bbc.com/news",
    ]
  ),
  builtIn(
    "docs",
    "Docs",
    "Everyday web development references: platform docs, compatibility and answers.",
    "📚",
    [],
    ["https://developer.mozilla.org", "https://caniuse.com", "https://stackoverflow.com"]
  ),
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > max ? text.slice(0, max) : text;
}

function httpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function cloneTemplate(value: SpaceTemplate): SpaceTemplate {
  return {
    ...value,
    folders: value.folders.map((folder) => ({ label: folder.label, urls: [...folder.urls] })),
    looseUrls: [...value.looseUrls],
  };
}

function validateName(name: string): string {
  const display = String(name ?? "").trim();
  if (!display) throw new Error("Template name cannot be empty.");
  if (display.length > MAX_NAME_LENGTH) {
    throw new Error(`Template name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  return display;
}

function uniqueSpaceName(desired: string, taken: Set<string>): string {
  const base = desired || "Space";
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function findUserTemplate(file: TemplatesFile, name: string): SpaceTemplate | undefined {
  const key = name.trim().toLowerCase();
  return file.templates.find((entry) => entry.name.toLowerCase() === key);
}

function boundUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_URL_LENGTH ? trimmed : null;
}

function sanitizeUrls(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || limit <= 0) return [];
  const urls: string[] = [];
  for (const entry of value.slice(0, limit)) {
    const url = boundUrl(entry);
    if (url) urls.push(url);
  }
  return urls;
}

function sanitizeUserTemplate(value: unknown): SpaceTemplate | null {
  if (!isRecord(value)) return null;
  const name = boundedText(value.name, MAX_NAME_LENGTH);
  if (!name) return null;
  if (BUILTIN_TEMPLATES.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
    return null;
  }
  let budget = MAX_URLS_PER_TEMPLATE;
  const folders: SpaceTemplateFolder[] = [];
  const rawFolders = Array.isArray(value.folders) ? value.folders : [];
  for (const raw of rawFolders.slice(0, MAX_FOLDERS_PER_TEMPLATE)) {
    if (budget <= 0 || !isRecord(raw)) continue;
    const urls = sanitizeUrls(raw.urls, budget);
    budget -= urls.length;
    folders.push({
      label: boundedText(raw.label, MAX_NAME_LENGTH) || "Folder",
      urls,
    });
  }
  const createdAt = boundedText(value.createdAt, MAX_CREATED_AT_LENGTH);
  return {
    name,
    label: boundedText(value.label, MAX_NAME_LENGTH) || name,
    description: boundedText(value.description, MAX_DESCRIPTION_LENGTH),
    icon: boundedText(value.icon, MAX_ICON_LENGTH) || null,
    builtIn: false,
    ...(createdAt ? { createdAt } : {}),
    folders,
    looseUrls: sanitizeUrls(value.looseUrls, budget),
  };
}

function sanitizeTemplates(value: unknown[]): {
  templates: SpaceTemplate[];
  skipped: number;
} {
  const templates: SpaceTemplate[] = [];
  let skipped = 0;
  for (const entry of value) {
    if (templates.length >= MAX_USER_TEMPLATES) {
      skipped += 1;
      continue;
    }
    const template = sanitizeUserTemplate(entry);
    if (!template) {
      skipped += 1;
      continue;
    }
    templates.push(template);
  }
  return { templates, skipped };
}

export class TemplateStore {
  readonly #dir: string;
  readonly #hub: TemplateHubLike;
  #warnedInvalid = false;

  constructor(options: TemplateStoreOptions) {
    this.#dir = options.dir;
    this.#hub = options.hub as unknown as TemplateHubLike;
  }

  get path(): string {
    return join(this.#dir, FILE_NAME);
  }

  /** With a name, returns one template; otherwise returns all of them. */
  list(name?: string): SpaceTemplate[] | SpaceTemplate {
    const all = [
      ...BUILTIN_TEMPLATES.map(cloneTemplate),
      ...this.#read().templates.map(cloneTemplate),
    ];
    if (name === undefined) return all;
    const key = String(name).trim().toLowerCase();
    const found = all.find((entry) => entry.name.toLowerCase() === key);
    if (!found) throw new Error(`Template "${String(name).trim()}" not found.`);
    return found;
  }

  get(name: string): SpaceTemplate | null {
    const key = String(name ?? "").trim().toLowerCase();
    const all = this.list() as SpaceTemplate[];
    return all.find((entry) => entry.name.toLowerCase() === key) ?? null;
  }

  async saveFromSpace(
    spaceName: string,
    name: string,
    options: TemplateSaveOptions = {}
  ): Promise<SpaceTemplate> {
    const display = validateName(name);
    if (this.get(display)) throw new Error(`A template named "${display}" already exists.`);

    const spaces = await this.#hub.listSpaces();
    const key = String(spaceName ?? "").trim().toLowerCase();
    const space = spaces.spaces.find(
      (entry) => entry.id === spaceName || entry.name.toLowerCase() === key
    );
    if (!space) throw new Error(`Space "${String(spaceName ?? "").trim()}" not found.`);

    const [tabs, folders] = await Promise.all([
      this.#hub.listTabs({ space: space.id, limit: MAX_URLS_PER_TEMPLATE }),
      this.#hub.listFolders(),
    ]);
    if (tabs.total > tabs.tabs.length) {
      throw new Error(
        `Space "${space.name}" has ${tabs.total} tabs; a template can hold at most ` +
          `${MAX_URLS_PER_TEMPLATE}.`
      );
    }
    const folderById = new Map(folders.folders.map((folder) => [folder.id, folder]));
    const grouped = new Map<string, string[]>();
    const looseUrls: string[] = [];
    const ordered = tabs.tabs.filter((tab) => !tab.essential).sort((a, b) => a.index - b.index);
    for (const tab of ordered) {
      const url = httpUrl(tab.url);
      if (!url) continue;
      const record = tab.folderId ? folderById.get(tab.folderId) : undefined;
      const label = record?.label ?? tab.folderLabel ?? null;
      if (label) {
        const urls = grouped.get(label) ?? [];
        urls.push(url);
        grouped.set(label, urls);
      } else {
        looseUrls.push(url);
      }
    }

    const saved: SpaceTemplate = {
      name: display,
      label: display,
      description: boundedText(options.description, MAX_DESCRIPTION_LENGTH),
      icon: boundedText(options.icon, MAX_ICON_LENGTH) || null,
      builtIn: false,
      createdAt: new Date().toISOString(),
      folders: [...grouped].map(([label, urls]) => ({ label, urls })),
      looseUrls,
    };
    this.#commit((file) => {
      if (findUserTemplate(file, display)) {
        throw new Error(`A template named "${display}" already exists.`);
      }
      if (file.templates.length >= MAX_USER_TEMPLATES) {
        throw new Error(`Template storage holds at most ${MAX_USER_TEMPLATES} templates.`);
      }
      file.templates.push(saved);
    });
    return cloneTemplate(saved);
  }

  delete(name: string): boolean {
    const key = String(name ?? "").trim().toLowerCase();
    if (BUILTIN_TEMPLATES.some((entry) => entry.name.toLowerCase() === key)) {
      throw new Error(`Built-in template "${String(name).trim()}" cannot be deleted.`);
    }
    let removed = false;
    this.#commit((file) => {
      const index = file.templates.findIndex(
        (entry) => entry.name.toLowerCase() === key
      );
      if (index === -1) return;
      file.templates.splice(index, 1);
      removed = true;
    });
    return removed;
  }

  async apply(
    name: string,
    options: TemplateApplyOptions = {}
  ): Promise<SpaceTemplateApplyResult> {
    const template = this.get(name);
    if (!template) throw new Error(`Template "${String(name ?? "").trim()}" not found.`);
    const background = options.background !== false;
    const spaces = await this.#hub.listSpaces();
    const taken = new Set(spaces.spaces.map((space) => space.name.toLowerCase()));
    const desired = String(
      options.spaceName?.trim() || template.label || template.name
    ).slice(0, MAX_NAME_LENGTH);
    const created = await this.#hub.createSpace({
      name: uniqueSpaceName(desired, taken),
      ...(template.icon ? { icon: template.icon } : {}),
      switchTo: !background,
    });
    const space = created.space;
    const warnings: string[] = [];
    let tabsOpened = 0;
    let tabsFailed = 0;
    let foldersCreated = 0;

    const valid = (urls: string[], label: string): string[] => {
      const accepted: string[] = [];
      for (const url of urls) {
        const normalized = httpUrl(url);
        if (normalized) accepted.push(normalized);
        else {
          tabsFailed += 1;
          warnings.push(`Skipped non-http(s) URL "${url}" in ${label}.`);
        }
      }
      return accepted;
    };

    const openUrls = async (urls: string[], label: string): Promise<OpenedTab[]> => {
      const opened: OpenedTab[] = [];
      for (let start = 0; start < urls.length; start += BATCH_SIZE) {
        const batch = urls.slice(start, start + BATCH_SIZE);
        try {
          const result = await this.#hub.openTabs({
            urls: batch,
            space: space.id,
            background,
            switchTo: !background,
          });
          tabsOpened += result.tabs.length;
          opened.push(...result.tabs);
        } catch (error) {
          tabsFailed += batch.length;
          warnings.push(`Could not open ${batch.length} tab(s) for ${label}: ${messageOf(error)}`);
        }
      }
      return opened;
    };

    const loose = valid(template.looseUrls, `template "${template.name}"`);
    if (loose.length > 0) await openUrls(loose, `template "${template.name}"`);

    for (const folder of template.folders) {
      const label = `folder "${folder.label}" of template "${template.name}"`;
      const urls = valid(folder.urls, label);
      if (urls.length === 0) continue;
      const opened = await openUrls(urls, label);
      if (opened.length === 0) continue;
      try {
        const result = await this.#hub.createFolder({
          label: folder.label,
          tabIds: opened.map((tab) => tab.id),
          space: space.id,
          collapsed: false,
        });
        if (result.created) foldersCreated += 1;
      } catch (error) {
        warnings.push(`Could not create folder "${folder.label}": ${messageOf(error)}`);
      }
    }

    return {
      template: template.name,
      space,
      tabsOpened,
      foldersCreated,
      tabsFailed,
      warnings,
    };
  }

  #read(): TemplatesFile {
    const file = this.path;
    if (!existsSync(file)) return { version: 1, templates: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileTextBounded(file, MAX_FILE_BYTES));
    } catch (error) {
      throw new Error(`Could not parse ${file}: ${messageOf(error)}.`);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.templates)) {
      throw new Error(`Could not read ${file}: expected a versioned templates array.`);
    }
    const { templates, skipped } = sanitizeTemplates(parsed.templates);
    if (skipped > 0 && !this.#warnedInvalid) {
      this.#warnedInvalid = true;
      process.stderr.write(`zen-control: ignored ${skipped} invalid template entry/entries in ${file}.\n`);
    }
    return { version: 1, templates };
  }

  #commit(mutate: (file: TemplatesFile) => void): void {
    const file = this.#read();
    mutate(file);
    const text = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`The templates file would exceed ${MAX_FILE_BYTES} bytes.`);
    }
    atomicWritePrivate(this.path, text);
  }
}
