/** Fixed caps for the bounded "snapshot" read format. */
export const SNAPSHOT_TEXT_CHARS = 4_000;
export const SNAPSHOT_DEFAULT_ELEMENTS = 100;
export const SNAPSHOT_MAX_ELEMENTS = 200;
export const SNAPSHOT_MAX_HEADINGS = 80;
export const SNAPSHOT_HEADING_CHARS = 160;
export const SNAPSHOT_MAX_LIMITATIONS = 5;

/** Clamps a caller-supplied control cap into 1..200, defaulting to 100. */
export function clampSnapshotElements(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return SNAPSHOT_DEFAULT_ELEMENTS;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return SNAPSHOT_DEFAULT_ELEMENTS;
  return Math.min(SNAPSHOT_MAX_ELEMENTS, Math.max(1, Math.floor(numeric)));
}

export interface SnapshotCompletenessInput {
  /** Frames never reached because the discovery listing hit its cap. */
  unlistedFrames?: number;
  /** Listed frames whose content could not be inspected. */
  unreadableFrames?: number;
  /** Frames intentionally skipped (non-http(s), cross-origin, etc.). */
  skippedFrames?: number;
  /** A selector limited the read to one subtree, excluding frames by design. */
  selector?: boolean;
}

export interface SnapshotCompletenessResult {
  framesComplete: boolean;
  snapshotComplete: boolean;
  limitations: string[];
}

/**
 * Collection completeness is about missing controls, not about output caps.
 * Text/element/heading truncation never makes a snapshot incomplete; an
 * unreadable or undiscovered frame does, because controls may live there.
 */
export function snapshotCompleteness(
  input: SnapshotCompletenessInput = {}
): SnapshotCompletenessResult {
  if (input.selector === true) {
    return {
      framesComplete: true,
      snapshotComplete: true,
      limitations: [
        "Frame controls were not included because the selector scoped the " +
          "snapshot to a single subtree.",
      ],
    };
  }

  const limitations: string[] = [];
  const unlisted = Math.max(0, Math.floor(Number(input.unlistedFrames) || 0));
  const unreadable = Math.max(0, Math.floor(Number(input.unreadableFrames) || 0));
  const skipped = Math.max(0, Math.floor(Number(input.skippedFrames) || 0));

  if (unlisted > 0) {
    limitations.push(
      `The child-frame listing hit its cap; ${unlisted} unlisted frame(s) ` +
        "were never scanned and their controls are absent."
    );
  }
  if (unreadable > 0) {
    limitations.push(
      `${unreadable} child frame(s) could not be read; their controls are absent.`
    );
  }
  if (skipped > 0) {
    limitations.push(
      `${skipped} child frame(s) were skipped because they were not http(s) ` +
        "or could not be inspected; their controls are absent."
    );
  }

  const framesComplete = limitations.length === 0;
  return {
    framesComplete,
    snapshotComplete: framesComplete,
    limitations: limitations.slice(0, SNAPSHOT_MAX_LIMITATIONS),
  };
}
