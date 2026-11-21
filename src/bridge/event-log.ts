/**
 * Bounded event stream shared by the bridge host and the `zen_events` tool.
 *
 * Sequence ids are the only cursor: monotonic, never reused. Browser
 * observations expire after ten minutes; user control events (stop, pause,
 * question, watch) stay. On overflow the oldest browser observation is evicted
 * first so a burst of tab noise cannot push control events out of the buffer.
 */
import type { AgentEvent, EventsResult } from "../shared/protocol.js";
import { BROWSER_EVENT_KINDS } from "../shared/protocol.js";

export const EVENT_TTL_MS = 10 * 60_000;
export const MAX_EVENTS = 200;
export const DEDUPE_WINDOW_MS = 2_000;
const MAX_DEDUPE_KEYS = 500;

const BROWSER_KINDS: ReadonlySet<AgentEvent["kind"]> = new Set(
  BROWSER_EVENT_KINDS
);

export function isBrowserObservation(kind: AgentEvent["kind"]): boolean {
  return BROWSER_KINDS.has(kind);
}

export function filterPausedEvents(
  events: readonly AgentEvent[],
  paused: boolean
): AgentEvent[] {
  return paused ? events.filter((event) => !isBrowserObservation(event.kind)) : [...events];
}

export type EventInput = Omit<AgentEvent, "id" | "at">;
export type EventLogRead = EventsResult;

interface DedupeEntry {
  at: number;
  event: AgentEvent;
}

export class EventLog {
  readonly #events: AgentEvent[] = [];
  readonly #dedupe = new Map<string, DedupeEntry>();
  readonly #maxEvents: number;
  readonly #ttlMs: number;
  #seq = 0;
  #dropped = 0;
  #filtered = 0;
  #paused = false;
  #stopped = false;

  constructor(options: { maxEvents?: number; ttlMs?: number } = {}) {
    this.#maxEvents = Math.max(1, Math.floor(options.maxEvents ?? MAX_EVENTS));
    this.#ttlMs = Math.max(0, Math.floor(options.ttlMs ?? EVENT_TTL_MS));
  }

  get size(): number {
    this.#prune();
    return this.#events.length;
  }

  /** Highest id handed out so far. */
  get lastId(): number {
    return this.#seq;
  }

  get sequence(): number {
    return this.#seq;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get filtered(): number {
    return this.#filtered;
  }

  setPaused(paused: boolean): void {
    this.#paused = paused;
    if (paused) this.dropBrowserWhilePaused();
  }

  setStopped(stopped: boolean): void {
    this.#stopped = stopped;
  }

  addFiltered(count: number): void {
    if (Number.isFinite(count) && count > 0) this.#filtered += Math.floor(count);
  }

  /**
   * Adds an event and returns the stored record, or null when the observation
   * was deduplicated. A null result must not wake long-poll waiters.
   */
  push(input: EventInput): AgentEvent | null {
    this.#prune();
    const now = Date.now();
    const key = [
      input.kind,
      input.phase ?? "",
      input.windowId ?? "",
      input.tabId ?? "",
      input.documentId ?? "",
      input.url ?? "",
      input.title ?? "",
      // Dialogs carry no tab/url/document identity and share a constant title;
      // their label is the only thing that distinguishes consecutive dialogs.
      input.kind === "dialog" ? input.detail ?? "" : "",
    ].join("|");
    const seen = this.#dedupe.get(key);
    if (isBrowserObservation(input.kind) && seen && now - seen.at < DEDUPE_WINDOW_MS) {
      seen.at = now;
      this.#touchDedupe(key, seen);
      return null;
    }

    const event: AgentEvent = { ...input, id: ++this.#seq, at: now };
    this.#events.push(event);
    if (isBrowserObservation(input.kind)) {
      this.#dedupe.set(key, { at: now, event });
      this.#touchDedupe(key, { at: now, event });
    }
    while (this.#events.length > this.#maxEvents) {
      const browserIndex = this.#events.findIndex((entry) =>
        isBrowserObservation(entry.kind)
      );
      if (browserIndex >= 0) this.#events.splice(browserIndex, 1);
      else this.#events.shift();
      this.#dropped += 1;
    }
    return event;
  }

  /** Removes buffered browser observations; used when Pause is pressed. */
  dropBrowserWhilePaused(): void {
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      if (isBrowserObservation(this.#events[index].kind)) {
        this.#events.splice(index, 1);
        this.#filtered += 1;
      }
    }
    this.#dedupe.clear();
  }

  read(after: number): EventsResult {
    this.#prune();
    const cursorValue = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0;
    const matching = this.#events.filter((event) => event.id > cursorValue);
    const events = filterPausedEvents(matching, this.#paused);
    const last = events[events.length - 1];
    const oldest = this.#events[0];
    const effectiveAfter = Math.min(this.#seq, cursorValue);
    return {
      events,
      cursor: last ? last.id : this.#seq,
      stopped: this.#stopped,
      paused: this.#paused,
      lastEventAt: last ? last.at : null,
      missed: Math.max(0, this.#seq - effectiveAfter - matching.length),
      oldestCursor: oldest ? oldest.id : null,
      dropped: this.#dropped,
      filtered: this.#filtered,
    };
  }

  clear(): void {
    this.#events.length = 0;
    this.#dedupe.clear();
  }

  #touchDedupe(key: string, entry: DedupeEntry): void {
    this.#dedupe.delete(key);
    this.#dedupe.set(key, entry);
    while (this.#dedupe.size > MAX_DEDUPE_KEYS) {
      const oldest = this.#dedupe.keys().next().value;
      if (oldest === undefined) return;
      this.#dedupe.delete(oldest);
    }
  }

  #prune(): void {
    if (this.#ttlMs === 0) return;
    const cutoff = Date.now() - this.#ttlMs;
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      const event = this.#events[index];
      if (isBrowserObservation(event.kind) && event.at < cutoff) {
        this.#events.splice(index, 1);
        this.#dropped += 1;
      }
    }
  }
}
