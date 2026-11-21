/**
 * Server-side registry of interactive-read refs.
 *
 * A ref is never written into the page. It pairs a short label (`e3`, `f0-e1`)
 * with a Marionette WebElement handle plus a small, value-free descriptor. A
 * fresh snapshot replaces the whole ref set for one document (tab + frame
 * path), so an old ref from the same document becomes stale immediately.
 * Documents are bounded and least-recently-used; closing a tab forgets all of
 * its frames.
 */

export interface RefDescriptor {
  tag: string;
  role: string;
  type: string | null;
  label: string;
  href: string | null;
}

export interface StoredRef {
  ref: string;
  /** Marionette WebElement handle; held only server-side, never sent to a page. */
  element: unknown;
  /** Same-node guard, not an identity. Excludes values and toggle state. */
  digest: string;
  descriptor: RefDescriptor;
  snapshotId: string;
  capturedAt: number;
}

export interface ResolvedRef extends StoredRef {
  /** documentElement WebElement captured with the snapshot. */
  root: unknown;
  framePath: number[];
}

interface DocumentRecord {
  tabId: string;
  framePath: number[];
  snapshotId: string;
  root: unknown;
  refs: Map<string, StoredRef>;
  capturedAt: number;
}

export interface RefRegistryOptions {
  maxDocuments?: number;
  maxRefs?: number;
}

const DEFAULT_MAX_DOCUMENTS = 64;
const DEFAULT_MAX_REFS = 400;
const MAX_FRAME_DEPTH = 3;

function normalizeText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function clampPath(framePath: readonly unknown[] | undefined): number[] {
  if (!Array.isArray(framePath)) return [];
  return framePath
    .slice(0, MAX_FRAME_DEPTH)
    .map((index) => Math.max(0, Math.floor(Number(index) || 0)));
}

/** FNV-1a over the stable descriptor parts. */
export function elementDigest(element: {
  tag?: string | null;
  role?: string | null;
  type?: string | null;
  label?: string | null;
  href?: string | null;
}): string {
  const parts = [
    element?.tag,
    element?.role,
    element?.type,
    element?.label,
    element?.href,
  ].map((part) => normalizeText(part));
  let hash = 2166136261;
  for (const part of parts) {
    for (const text of [`${part}\u0000`]) {
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Reads the UUID out of a Marionette WebElement without interpreting it. */
export function webElementId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!key.startsWith("element-")) continue;
    const id = record[key];
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/** True only when both roots are known handles with different ids. */
export function documentChanged(storedRoot: unknown, freshRoot: unknown): boolean {
  const before = webElementId(storedRoot);
  const after = webElementId(freshRoot);
  return before !== null && after !== null && before !== after;
}

export class RefRegistry {
  readonly #documents = new Map<string, DocumentRecord>();
  readonly #maxDocuments: number;
  readonly #maxRefs: number;

  constructor(options: RefRegistryOptions = {}) {
    this.#maxDocuments = Math.max(
      1,
      Math.floor(options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS)
    );
    this.#maxRefs = Math.max(1, Math.floor(options.maxRefs ?? DEFAULT_MAX_REFS));
  }

  static key(tabId: string, framePath: readonly number[]): string {
    const path = clampPath(framePath);
    return `${tabId}|${path.length ? path.join(".") : "top"}`;
  }

  /** Starts a new ref set for one document, replacing any previous snapshot. */
  beginSnapshot(
    tabId: string,
    framePath: readonly number[],
    snapshotId: string,
    root: unknown
  ): void {
    if (!tabId) return;
    const path = clampPath(framePath);
    const key = RefRegistry.key(tabId, path);
    this.#documents.delete(key);
    this.#documents.set(key, {
      tabId,
      framePath: path,
      snapshotId,
      root,
      refs: new Map<string, StoredRef>(),
      capturedAt: Date.now(),
    });
    this.#evictOverflow();
  }

  /** Adds one ref to the current snapshot of a document. */
  register(
    tabId: string,
    framePath: readonly number[],
    ref: string,
    descriptor: RefDescriptor,
    element: unknown,
    digest: string
  ): void {
    if (!tabId || element === undefined || element === null) return;
    const key = RefRegistry.key(tabId, framePath);
    let record = this.#documents.get(key);
    if (!record) {
      this.beginSnapshot(tabId, framePath, "", null);
      record = this.#documents.get(key);
    }
    if (!record || record.refs.size >= this.#maxRefs) return;
    const label = normalizeText(ref).slice(0, 24);
    if (!label) return;
    const safe: RefDescriptor = {
      tag: normalizeText(descriptor?.tag).slice(0, 40),
      role: normalizeText(descriptor?.role).slice(0, 40) || "generic",
      type:
        descriptor?.type == null
          ? null
          : normalizeText(descriptor.type).slice(0, 40),
      label: normalizeText(descriptor?.label).slice(0, 300),
      href:
        descriptor?.href == null
          ? null
          : String(descriptor.href).slice(0, 8_000),
    };
    if (!safe.tag) return;
    record.refs.set(label, {
      ref: label,
      element,
      digest: typeof digest === "string" && digest ? digest : elementDigest(safe),
      descriptor: safe,
      snapshotId: record.snapshotId,
      capturedAt: Date.now(),
    });
  }

  resolve(
    ref: string,
    tabId: string,
    framePath: readonly number[]
  ): ResolvedRef | null {
    const key = RefRegistry.key(tabId, framePath);
    const record = this.#documents.get(key);
    if (!record) return null;
    const entry = record.refs.get(normalizeText(ref));
    if (!entry) return null;
    this.#touch(key, record);
    return {
      ...entry,
      root: record.root,
      framePath: [...record.framePath],
    };
  }

  /** Forgets every frame of one tab, called when the tab closes. */
  clearTab(tabId: string): void {
    for (const [key, record] of this.#documents) {
      if (record.tabId === tabId) this.#documents.delete(key);
    }
  }

  clearAll(): void {
    this.#documents.clear();
  }

  get documentCount(): number {
    return this.#documents.size;
  }

  refCount(tabId: string, framePath: readonly number[]): number {
    return this.#documents.get(RefRegistry.key(tabId, framePath))?.refs.size ?? 0;
  }

  #touch(key: string, record: DocumentRecord): void {
    this.#documents.delete(key);
    this.#documents.set(key, record);
  }

  #evictOverflow(): void {
    while (this.#documents.size > this.#maxDocuments) {
      const oldest = this.#documents.keys().next().value;
      if (oldest === undefined) return;
      this.#documents.delete(oldest);
    }
  }
}
