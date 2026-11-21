/**
 * Bounded before/after page signatures and the action delta derived from them.
 * Signatures hash text and form values instead of returning them, so no field
 * content leaks through an interaction result.
 */
import type { ActionControlBrief, ActionControlChange, PageActionDelta } from "./protocol.js";

export const DELTA_MAX_CONTROLS = 10;
export const DELTA_MAX_HEADINGS = 5;
export const DELTA_MAX_ALERTS = 5;

export interface PageControlSignature {
  key: string;
  role: string;
  name: string;
  type: string | null;
  state: Record<string, boolean>;
}

export interface PageTextSignature {
  key: string;
  text: string;
}

export interface PageSignature {
  url: string;
  title: string;
  readyState: string;
  textLength: number;
  textHash: number;
  elementCount: number;
  valueHash: number;
  root?: unknown;
  controls: PageControlSignature[];
  headings: PageTextSignature[];
  alerts: PageTextSignature[];
}

export interface SignatureDiff {
  changed: boolean;
  urlChanged: boolean;
  titleChanged: boolean;
  domChanged: boolean;
  valueChanged: boolean;
}

const EMPTY_DIFF: SignatureDiff = {
  changed: false,
  urlChanged: false,
  titleChanged: false,
  domChanged: false,
  valueChanged: false,
};

function emptyDelta(readyState: string, limitation?: string): PageActionDelta {
  return {
    addedControls: [],
    removedControls: [],
    changedControls: [],
    addedHeadings: [],
    removedHeadings: [],
    addedAlerts: [],
    removedAlerts: [],
    textChanged: false,
    textLengthDelta: 0,
    readyState,
    ...(limitation ? { limitation } : {}),
  };
}

/** A missing signature means nothing can be concluded; report no change. */
export function comparePageSignatures(
  before: PageSignature | null,
  after: PageSignature | null
): SignatureDiff {
  if (!before || !after) return { ...EMPTY_DIFF };
  const urlChanged = before.url !== after.url;
  const titleChanged = before.title !== after.title;
  const valueChanged = before.valueHash !== after.valueHash;
  const domChanged =
    before.textLength !== after.textLength ||
    before.textHash !== after.textHash ||
    before.elementCount !== after.elementCount ||
    before.readyState !== after.readyState;
  return {
    changed: urlChanged || titleChanged || domChanged || valueChanged,
    urlChanged,
    titleChanged,
    domChanged,
    valueChanged,
  };
}

export function deltaHasChanges(delta: PageActionDelta): boolean {
  return (
    delta.addedControls.length > 0 ||
    delta.removedControls.length > 0 ||
    delta.changedControls.length > 0 ||
    delta.addedHeadings.length > 0 ||
    delta.removedHeadings.length > 0 ||
    delta.addedAlerts.length > 0 ||
    delta.removedAlerts.length > 0 ||
    delta.textChanged
  );
}

function brief(control: PageControlSignature): ActionControlBrief {
  return { role: control.role, name: control.name, type: control.type };
}

function stateChanges(before: PageControlSignature, after: PageControlSignature): string[] {
  const keys = new Set([...Object.keys(before.state), ...Object.keys(after.state)]);
  const changes: string[] = [];
  // The signature key hashes attributes that do not include the resolved ARIA
  // role or a label reached through aria-labelledby, so those can change while
  // the key stays identical. Report them explicitly.
  if (before.role !== after.role) changes.push("role");
  if (before.name !== after.name) changes.push("name");
  for (const key of keys) {
    if ((before.state[key] ?? false) !== (after.state[key] ?? false)) changes.push(key);
  }
  return changes.sort();
}

function textCounts(entries: PageTextSignature[] | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries ?? []) {
    if (!entry.text) continue;
    counts.set(entry.text, (counts.get(entry.text) ?? 0) + 1);
  }
  return counts;
}

function textDelta(
  before: Map<string, number>,
  after: Map<string, number>,
  limit: number
): { added: string[]; removed: string[] } {
  const added: string[] = [];
  for (const [text, count] of after) {
    for (let i = before.get(text) ?? 0; i < count && added.length < limit; i += 1) {
      added.push(text);
    }
  }
  const removed: string[] = [];
  for (const [text, count] of before) {
    for (let i = after.get(text) ?? 0; i < count && removed.length < limit; i += 1) {
      removed.push(text);
    }
  }
  return { added, removed };
}

/**
 * Builds the bounded delta. Never diff controls across a replaced document:
 * the keys would describe unrelated pages.
 */
export function buildPageDelta(
  before: PageSignature | null,
  after: PageSignature | null,
  documentChanged: boolean
): { delta: PageActionDelta; hasChanges: boolean } {
  const readyState = after?.readyState ?? before?.readyState ?? "";
  if (!before || !after) {
    return {
      delta: emptyDelta(
        readyState,
        "A before/after page signature was unavailable, so controls were not compared."
      ),
      hasChanges: false,
    };
  }
  if (documentChanged) {
    return {
      delta: emptyDelta(
        readyState,
        "The document was replaced, so controls were not compared across documents. Read the new page for a current snapshot."
      ),
      hasChanges: false,
    };
  }

  const beforeControls = new Map(before.controls.map((control) => [control.key, control]));
  const afterControls = new Map(after.controls.map((control) => [control.key, control]));
  const addedControls: ActionControlBrief[] = [];
  const removedControls: ActionControlBrief[] = [];
  const changedControls: ActionControlChange[] = [];

  for (const [key, control] of afterControls) {
    if (beforeControls.has(key) || addedControls.length >= DELTA_MAX_CONTROLS) continue;
    addedControls.push(brief(control));
  }
  for (const [key, control] of beforeControls) {
    if (afterControls.has(key) || removedControls.length >= DELTA_MAX_CONTROLS) continue;
    removedControls.push(brief(control));
  }
  for (const [key, current] of afterControls) {
    const previous = beforeControls.get(key);
    if (!previous || changedControls.length >= DELTA_MAX_CONTROLS) continue;
    const changes = stateChanges(previous, current);
    if (changes.length > 0) changedControls.push({ ...brief(current), changes });
  }

  const headings = textDelta(
    textCounts(before.headings), textCounts(after.headings), DELTA_MAX_HEADINGS
  );
  const alerts = textDelta(
    textCounts(before.alerts), textCounts(after.alerts), DELTA_MAX_ALERTS
  );

  const delta: PageActionDelta = {
    addedControls,
    removedControls,
    changedControls,
    addedHeadings: headings.added,
    removedHeadings: headings.removed,
    addedAlerts: alerts.added,
    removedAlerts: alerts.removed,
    textChanged: before.textHash !== after.textHash || before.textLength !== after.textLength,
    textLengthDelta: after.textLength - before.textLength,
    readyState,
  };
  return { delta, hasChanges: deltaHasChanges(delta) };
}
