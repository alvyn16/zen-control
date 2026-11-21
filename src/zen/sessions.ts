/**
 * Named snapshots of the browser's space/folder/tab layout.
 *
 * Session files are treated as untrusted input: every field is re-validated on
 * read, writes are private and atomic, and restoration reports partial
 * failures as warnings rather than aborting the whole session.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BridgeHub } from "../bridge/host.js";
import type {
  CreateFolderParams,
  CreateFolderResult,
  CreateSpaceParams,
  CreateSpaceResult,
  EssentialsParams,
  EssentialsResult,
  FoldersResult,
  OpenedTab,
  OpenTabsParams,
  OpenTabsResult,
  PinTabsParams,
  PinTabsResult,
  SpacesResult,
  TabsListParams,
  TabsResult,
} from "../shared/protocol.js";
import { atomicWritePrivate, readFileTextBounded } from "../utils/safe-file.js";

const FILE_NAME = "sessions.json";
const BATCH_SIZE = 30;
const DEFAULT_MAX_TABS = 300;
const MAX_NAME_LENGTH = 64;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 100;
const MAX_SPACES_PER_SESSION = 50;
const MAX_TABS_PER_SESSION = 2000;
const MAX_FOLDERS_PER_SPACE = 200;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 300;
const MAX_ICON_LENGTH = 200;
const MAX_CREATED_AT_LENGTH = 64;

export interface SessionFolder {
  label: string;
  collapsed: boolean;
}

export interface SessionTab {
  url: string;
  title: string;
  pinned: boolean;
  essential: boolean;
  folder: string | null;
}

export interface SessionSpace {
  name: string;
  icon: string | null;
  containerTabId: number;
  tabs: SessionTab[];
  folders: SessionFolder[];
}

export interface SessionSnapshot {
  version: 1;
  name: string;
  createdAt: string;
  spaces: SessionSpace[];
  essentials: SessionTab[];
}

export interface SessionSummary {
  name: string;
  createdAt: string;
  spaceCount: number;
  tabCount: number;
  essentialCount: number;
}

export interface SessionRestoreOptions {
  newSpaces?: boolean;
  switchTo?: boolean;
  maxTabs?: number;
}

export interface SessionRestoreResult {
  name: string;
  spacesCreated: number;
  spacesReused: number;
  tabsOpened: number;
  tabsSkipped: number;
  foldersCreated: number;
  essentialsAdded: number;
  warnings: string[];
}

/** Only the hub operations a session needs; keeps the store easy to test. */
export interface SessionHubLike {
  listSpaces(windowId?: string): Promise<SpacesResult>;
  listTabs(params: TabsListParams, windowId?: string): Promise<TabsResult>;
  listFolders(windowId?: string): Promise<FoldersResult>;
  createSpace(params: CreateSpaceParams, windowId?: string): Promise<CreateSpaceResult>;
  openTabs(params: OpenTabsParams, windowId?: string): Promise<OpenTabsResult>;
  createFolder(params: CreateFolderParams, windowId?: string): Promise<CreateFolderResult>;
  pinTabs(params: PinTabsParams, windowId?: string): Promise<PinTabsResult>;
  addEssentials(params: EssentialsParams, windowId?: string): Promise<EssentialsResult>;
}

export interface SessionStoreOptions {
  dir: string;
  hub: BridgeHub;
}

interface SessionsFile {
  version: 1;
  sessions: SessionSnapshot[];
}

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

/** Only http(s) URLs are restorable; everything else is dropped. */
function restorableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

function validateName(name: string, kind: string): string {
  const display = String(name ?? "").trim();
  if (!display) throw new Error(`${kind} name cannot be empty.`);
  if (display.length > MAX_NAME_LENGTH) {
    throw new Error(`${kind} name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  return display;
}

function findSession(file: SessionsFile, name: string): SessionSnapshot | undefined {
  const key = name.trim().toLowerCase();
  return file.sessions.find((session) => session.name.toLowerCase() === key);
}

function normalizeMaxTabs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_TABS;
  return Math.max(0, Math.floor(value));
}

/** Appends a suffix when a space of the same name already exists. */
function restoredName(base: string, taken: Set<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  const simple = `${base} (restored)`;
  if (!taken.has(simple.toLowerCase())) return simple;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} (restored ${suffix})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function urlKey(url: string): string {
  return String(url ?? "").trim();
}

function mapOpened(tabs: OpenedTab[]): Map<string, OpenedTab> {
  const map = new Map<string, OpenedTab>();
  for (const tab of tabs) {
    if (tab.requestedUrl) map.set(urlKey(tab.requestedUrl), tab);
    map.set(urlKey(tab.url), tab);
  }
  return map;
}

function sanitizeTab(value: unknown): SessionTab | null {
  if (!isRecord(value)) return null;
  const url = restorableUrl(value.url);
  if (!url) return null;
  return {
    url,
    title: boundedText(value.title, MAX_TITLE_LENGTH),
    pinned: value.pinned === true,
    essential: value.essential === true,
    folder: boundedText(value.folder, MAX_NAME_LENGTH) || null,
  };
}

function sanitizeTabs(value: unknown, limit: number): SessionTab[] {
  if (!Array.isArray(value) || limit <= 0) return [];
  const result: SessionTab[] = [];
  for (const entry of value.slice(0, limit)) {
    const tab = sanitizeTab(entry);
    if (tab) result.push(tab);
  }
  return result;
}

function sanitizeFolder(value: unknown): SessionFolder | null {
  if (!isRecord(value)) return null;
  const label = boundedText(value.label, MAX_NAME_LENGTH);
  return label ? { label, collapsed: value.collapsed === true } : null;
}

function sanitizeSessions(value: unknown[]): { sessions: SessionSnapshot[]; skipped: number } {
  const sessions: SessionSnapshot[] = [];
  let skipped = 0;
  for (const entry of value) {
    if (sessions.length >= MAX_SESSIONS || !isRecord(entry)) {
      skipped += 1;
      continue;
    }
    const name = boundedText(entry.name, MAX_NAME_LENGTH);
    if (!name) {
      skipped += 1;
      continue;
    }
    const createdAt =
      boundedText(entry.createdAt, MAX_CREATED_AT_LENGTH) || new Date(0).toISOString();
    const spaces: SessionSpace[] = [];
    let remaining = MAX_TABS_PER_SESSION;
    const rawSpaces = Array.isArray(entry.spaces) ? entry.spaces : [];
    for (const raw of rawSpaces.slice(0, MAX_SPACES_PER_SESSION)) {
      if (!isRecord(raw)) continue;
      const spaceName = boundedText(raw.name, MAX_NAME_LENGTH);
      if (!spaceName) continue;
      const tabs = sanitizeTabs(raw.tabs, remaining);
      remaining -= tabs.length;
      const folders: SessionFolder[] = [];
      if (Array.isArray(raw.folders)) {
        for (const rawFolder of raw.folders.slice(0, MAX_FOLDERS_PER_SPACE)) {
          const folder = sanitizeFolder(rawFolder);
          if (folder) folders.push(folder);
        }
      }
      spaces.push({
        name: spaceName,
        icon: boundedText(raw.icon, MAX_ICON_LENGTH) || null,
        containerTabId:
          Number.isInteger(raw.containerTabId) && Number(raw.containerTabId) >= 0
            ? Number(raw.containerTabId)
            : 0,
        tabs,
        folders,
      });
    }
    sessions.push({
      version: 1,
      name,
      createdAt,
      spaces,
      essentials: sanitizeTabs(entry.essentials, remaining),
    });
  }
  return { sessions, skipped };
}

export class SessionStore {
  readonly #dir: string;
  readonly #hub: SessionHubLike;
  #warnedInvalid = false;

  constructor(options: SessionStoreOptions) {
    this.#dir = options.dir;
    this.#hub = options.hub as unknown as SessionHubLike;
  }

  get path(): string {
    return join(this.#dir, FILE_NAME);
  }

  list(): SessionSummary[] {
    return this.#read().sessions.map((session) => ({
      name: session.name,
      createdAt: session.createdAt,
      spaceCount: session.spaces.length,
      tabCount: session.spaces.reduce((sum, space) => sum + space.tabs.length, 0),
      essentialCount: session.essentials.length,
    }));
  }

  get(name: string): SessionSnapshot | null {
    const key = String(name ?? "").trim().toLowerCase();
    return this.#read().sessions.find((session) => session.name.toLowerCase() === key) ?? null;
  }

  async save(name: string, options: { windowId?: string } = {}): Promise<SessionSnapshot> {
    const display = validateName(name, "Session");
    if (findSession(this.#read(), display)) {
      throw new Error(`A session named "${display}" already exists.`);
    }

    const [spaces, tabs, folders] = await Promise.all([
      this.#hub.listSpaces(options.windowId),
      this.#hub.listTabs({ limit: MAX_TABS_PER_SESSION }, options.windowId),
      this.#hub.listFolders(options.windowId),
    ]);
    if (tabs.total > tabs.tabs.length) {
      throw new Error(
        `This window has ${tabs.total} tabs; a session can hold at most ` +
          `${MAX_TABS_PER_SESSION}.`
      );
    }

    const folderById = new Map(folders.folders.map((folder) => [folder.id, folder]));
    const essentials: SessionTab[] = [];
    for (const tab of tabs.tabs) {
      if (!tab.essential) continue;
      const url = restorableUrl(tab.url);
      if (!url) continue;
      essentials.push({
        url,
        title: boundedText(tab.title, MAX_TITLE_LENGTH),
        pinned: tab.pinned,
        essential: true,
        folder: null,
      });
    }

    const snapshotSpaces: SessionSpace[] = spaces.spaces.map((space) => {
      const foldersByName = new Map<string, SessionFolder>();
      const spaceTabs = tabs.tabs
        .filter((tab) => tab.spaceId === space.id && !tab.essential)
        .sort((a, b) => a.index - b.index);
      const savedTabs: SessionTab[] = [];
      for (const tab of spaceTabs) {
        const url = restorableUrl(tab.url);
        if (!url) continue;
        const record = tab.folderId ? folderById.get(tab.folderId) : undefined;
        const label = record?.label ?? tab.folderLabel ?? null;
        if (label) {
          foldersByName.set(label, {
            label,
            collapsed: record?.collapsed ?? false,
          });
        }
        savedTabs.push({
          url,
          title: boundedText(tab.title, MAX_TITLE_LENGTH),
          pinned: tab.pinned,
          essential: false,
          folder: label,
        });
      }
      return {
        name: boundedText(space.name, MAX_NAME_LENGTH) || "Space",
        icon: space.icon ? boundedText(space.icon, MAX_ICON_LENGTH) : null,
        containerTabId: space.containerTabId,
        tabs: savedTabs,
        folders: [...foldersByName.values()],
      };
    });

    const snapshot: SessionSnapshot = {
      version: 1,
      name: display,
      createdAt: new Date().toISOString(),
      spaces: snapshotSpaces,
      essentials,
    };
    this.#commit((file) => {
      if (findSession(file, display)) {
        throw new Error(`A session named "${display}" already exists.`);
      }
      if (file.sessions.length >= MAX_SESSIONS) {
        throw new Error(`Session storage holds at most ${MAX_SESSIONS} sessions.`);
      }
      file.sessions.push(snapshot);
    });
    return snapshot;
  }

  async restore(
    name: string,
    options: SessionRestoreOptions = {}
  ): Promise<SessionRestoreResult> {
    const snapshot = this.get(name);
    if (!snapshot) throw new Error(`Session "${String(name ?? "").trim()}" not found.`);

    const maxTabs = normalizeMaxTabs(options.maxTabs);
    const warnings: string[] = [];
    let spacesCreated = 0;
    let spacesReused = 0;
    let tabsOpened = 0;
    let tabsSkipped = 0;
    let foldersCreated = 0;
    let essentialsAdded = 0;
    let limitWarned = false;

    const [spaceState, tabState] = await Promise.all([
      this.#hub.listSpaces(),
      this.#hub.listTabs({ limit: MAX_TABS_PER_SESSION }),
    ]);
    const spacesByName = new Map(
      spaceState.spaces.map((space) => [space.name.toLowerCase(), space])
    );
    const takenNames = new Set(spacesByName.keys());
    const urlsBySpace = new Map<string, Set<string>>();
    for (const tab of tabState.tabs) {
      if (!tab.spaceId) continue;
      const set = urlsBySpace.get(tab.spaceId) ?? new Set<string>();
      set.add(urlKey(tab.url));
      if (tab.requestedUrl) set.add(urlKey(tab.requestedUrl));
      urlsBySpace.set(tab.spaceId, set);
    }

    let firstTargetId: string | null = null;
    for (const savedSpace of snapshot.spaces) {
      try {
        const existing = spacesByName.get(savedSpace.name.toLowerCase());
        let targetId: string;
        let targetName: string;
        const seen = new Set<string>();

        if (existing && !options.newSpaces) {
          targetId = existing.id;
          targetName = existing.name;
          spacesReused += 1;
          for (const url of urlsBySpace.get(existing.id) ?? []) seen.add(url);
        } else {
          const desired = existing ? restoredName(savedSpace.name, takenNames) : savedSpace.name;
          const created = await this.#hub.createSpace({
            name: desired,
            ...(savedSpace.icon ? { icon: savedSpace.icon } : {}),
            switchTo: options.switchTo ?? false,
          });
          targetId = created.space.id;
          targetName = created.space.name;
          takenNames.add(targetName.toLowerCase());
          spacesCreated += 1;
        }
        if (!firstTargetId) firstTargetId = targetId;

        const missing = savedSpace.tabs.filter(
          (tab) => tab.url.trim().length > 0 && !seen.has(urlKey(tab.url))
        );
        tabsSkipped += savedSpace.tabs.length - missing.length;

        const remaining = maxTabs - tabsOpened;
        let toOpen = missing;
        if (missing.length > remaining) {
          toOpen = missing.slice(0, Math.max(0, remaining));
          const overflow = missing.length - toOpen.length;
          tabsSkipped += overflow;
          if (!limitWarned && overflow > 0) {
            warnings.push(`Skipped ${overflow} tab(s) because restore is limited to ${maxTabs} tabs.`);
            limitWarned = true;
          }
        }

        const folderTabs = new Map<string, string[]>();
        for (let start = 0; start < toOpen.length; start += BATCH_SIZE) {
          const batch = toOpen.slice(start, start + BATCH_SIZE);
          const opened = await this.#hub.openTabs({
            urls: batch.map((tab) => tab.url),
            space: targetId,
            background: true,
            switchTo: false,
          });
          tabsOpened += opened.tabs.length;
          const byUrl = mapOpened(opened.tabs);
          const pinnedIds: string[] = [];
          for (const tab of batch) {
            const live = byUrl.get(urlKey(tab.url));
            if (!live) continue;
            seen.add(urlKey(live.url));
            if (live.requestedUrl) seen.add(urlKey(live.requestedUrl));
            if (tab.pinned && !tab.essential) pinnedIds.push(live.id);
            if (tab.folder) {
              const ids = folderTabs.get(tab.folder) ?? [];
              ids.push(live.id);
              folderTabs.set(tab.folder, ids);
            }
          }
          if (pinnedIds.length > 0) {
            try {
              await this.#hub.pinTabs({ tabIds: pinnedIds, pinned: true });
            } catch (error) {
              warnings.push(`Could not pin tabs in "${targetName}": ${messageOf(error)}`);
            }
          }
        }

        for (const [label, tabIds] of folderTabs) {
          if (tabIds.length === 0) continue;
          const collapsed =
            savedSpace.folders.find((folder) => folder.label === label)?.collapsed ?? false;
          try {
            const created = await this.#hub.createFolder({
              label,
              tabIds,
              space: targetId,
              collapsed,
            });
            if (created.created) foldersCreated += 1;
          } catch (error) {
            warnings.push(
              `Could not create folder "${label}" in "${targetName}": ${messageOf(error)}`
            );
          }
        }
      } catch (error) {
        warnings.push(`Could not restore space "${savedSpace.name}": ${messageOf(error)}`);
      }
    }

    if (snapshot.essentials.length > 0) {
      const targetId =
        firstTargetId ??
        spaceState.activeSpaceId ??
        spaceState.spaces[0]?.id ??
        null;
      if (!targetId) {
        warnings.push("Could not restore essentials because no space is available.");
      } else {
        const existing = new Set(
          tabState.tabs.filter((tab) => tab.essential).map((tab) => urlKey(tab.url))
        );
        const missing = snapshot.essentials.filter(
          (tab) => tab.url.trim() && !existing.has(urlKey(tab.url))
        );
        tabsSkipped += snapshot.essentials.length - missing.length;
        const remaining = Math.max(0, maxTabs - tabsOpened);
        let toOpen = missing;
        if (missing.length > remaining) {
          toOpen = missing.slice(0, remaining);
          tabsSkipped += missing.length - toOpen.length;
          if (!limitWarned && toOpen.length < missing.length) {
            warnings.push(
              `Skipped ${missing.length - toOpen.length} essential tab(s) because restore is limited to ${maxTabs} tabs.`
            );
            limitWarned = true;
          }
        }
        const essentialIds: string[] = [];
        for (let start = 0; start < toOpen.length; start += BATCH_SIZE) {
          const batch = toOpen.slice(start, start + BATCH_SIZE);
          try {
            const opened = await this.#hub.openTabs({
              urls: batch.map((tab) => tab.url),
              space: targetId,
              background: true,
              switchTo: false,
            });
            tabsOpened += opened.tabs.length;
            essentialIds.push(...opened.tabs.map((tab) => tab.id));
          } catch (error) {
            warnings.push(`Could not open essential tabs: ${messageOf(error)}`);
          }
        }
        if (essentialIds.length > 0) {
          try {
            essentialsAdded += (await this.#hub.addEssentials({ tabIds: essentialIds })).changed;
          } catch (error) {
            warnings.push(`Could not add essential tabs: ${messageOf(error)}`);
          }
        }
      }
    }

    return {
      name: snapshot.name,
      spacesCreated,
      spacesReused,
      tabsOpened,
      tabsSkipped,
      foldersCreated,
      essentialsAdded,
      warnings,
    };
  }

  delete(name: string): boolean {
    const key = String(name ?? "").trim().toLowerCase();
    let removed = false;
    this.#commit((file) => {
      const index = file.sessions.findIndex(
        (session) => session.name.toLowerCase() === key
      );
      if (index === -1) return;
      file.sessions.splice(index, 1);
      removed = true;
    });
    return removed;
  }

  #read(): SessionsFile {
    const file = this.path;
    if (!existsSync(file)) return { version: 1, sessions: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileTextBounded(file, MAX_FILE_BYTES));
    } catch (error) {
      throw new Error(`Could not parse ${file}: ${messageOf(error)}.`);
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
      throw new Error(`Could not read ${file}: expected a versioned sessions array.`);
    }
    const { sessions, skipped } = sanitizeSessions(parsed.sessions);
    if (skipped > 0 && !this.#warnedInvalid) {
      this.#warnedInvalid = true;
      process.stderr.write(`zen-control: ignored ${skipped} invalid session entry/entries in ${file}.\n`);
    }
    return { version: 1, sessions };
  }

  #commit(mutate: (file: SessionsFile) => void): void {
    const file = this.#read();
    mutate(file);
    const text = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
      throw new Error(`The sessions file would exceed ${MAX_FILE_BYTES} bytes.`);
    }
    atomicWritePrivate(this.path, text);
  }
}
