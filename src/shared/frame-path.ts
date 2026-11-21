/**
 * Frame paths address nested browsing contexts by child index. The same path
 * drives read drilling and ref naming: `f0-e3` is control 3 inside the first
 * child frame, `f0.1-e2` control 2 inside its second child.
 */
export const MAX_FRAME_DEPTH = 3;
export const MAX_FRAMES_LISTED = 20;
export const MAX_FRAME_SCANS = 10;

const FRAME_REF = /^(?:f([0-9]+(?:\.[0-9]+){0,2})-)?(e[0-9]{1,4})$/;

/**
 * Returns `[]` for the top document (also for null/undefined), and `undefined`
 * when the supplied value cannot be interpreted as a frame path.
 */
export function normalizeFramePath(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_FRAME_DEPTH) return undefined;
  const path: number[] = [];
  for (const entry of value) {
    if (!Number.isInteger(entry) || (entry as number) < 0) return undefined;
    path.push(entry as number);
  }
  return path;
}

/** `[]` -> "", `[0]` -> "f0-", `[0,1]` -> "f0.1-". */
export function frameRefPrefix(path: readonly number[] | undefined): string {
  return path && path.length > 0 ? `f${path.join(".")}-` : "";
}

/** Parses a ref such as `e12` or `f0.1-e2` into its frame path and index. */
export function parseFrameRef(ref: string): { path: number[]; index: number } | null {
  if (typeof ref !== "string") return null;
  const match = FRAME_REF.exec(ref);
  if (!match) return null;
  const path = match[1] ? match[1].split(".").map((part) => Number(part)) : [];
  if (path.length > MAX_FRAME_DEPTH) return null;
  const index = Number(match[2].slice(1));
  if (!Number.isInteger(index) || index < 1) return null;
  return { path, index };
}
