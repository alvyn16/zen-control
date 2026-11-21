import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { ClientEntry } from "./clients.js";
import { createTheme } from "./theme.js";

export interface PickerOption {
  id: string;
  label: string;
  detail: string;
  detected: boolean;
  popular: boolean;
  other?: boolean;
  selected: boolean;
}

export interface PickerResult {
  selected: string[];
  other: boolean;
}

export class SelectionCancelled extends Error {
  constructor() {
    super("selection cancelled");
    this.name = "SelectionCancelled";
  }
}

const OTHER_ID = "other";

/** Detected clients start checked; the "other" row starts unchecked. */
export function buildOptions(entries: ClientEntry[]): PickerOption[] {
  return [
    ...entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      detail: entry.detail,
      detected: entry.detected,
      popular: entry.popular,
      selected: entry.detected,
    })),
    {
      id: OTHER_ID,
      label: "Other MCP client",
      detail: "Print a setup prompt for any agent",
      detected: false,
      popular: false,
      other: true,
      selected: false,
    },
  ];
}

/** Cursor movement wraps around the ends of the list. */
export function moveCursor(
  options: PickerOption[],
  cursor: number,
  delta: number
): number {
  const size = options.length;
  if (size === 0) return 0;
  return (((cursor + delta) % size) + size) % size;
}

/** Window that only scrolls when the cursor would otherwise leave it. */
export function scrollWindow(
  total: number,
  cursor: number,
  height: number,
  start = 0
): { start: number; end: number } {
  const size = Math.max(1, Math.min(height, total));
  const limit = Math.max(0, total - size);
  let next = Math.max(0, Math.min(start, limit));
  if (cursor < next) next = cursor;
  if (cursor >= next + size) next = cursor - size + 1;
  next = Math.max(0, Math.min(next, limit));
  return { start: next, end: Math.min(total, next + size) };
}

/** Bulk toggle; the "other" row is deliberately left alone. */
export function toggleAll(options: PickerOption[], selected: boolean): PickerOption[] {
  return options.map((option) =>
    option.other ? option : { ...option, selected }
  );
}

export function pickerResult(options: PickerOption[]): PickerResult {
  return {
    selected: options
      .filter((option) => !option.other && option.selected)
      .map((option) => option.id),
    other: options.some((option) => option.other && option.selected),
  };
}

type BodyRow =
  | { kind: "header"; text: string }
  | { kind: "blank" }
  | { kind: "option"; index: number };

/** Section headings are part of the scrollable body, not a fixed pane. */
function buildBodyRows(rows: PickerOption[]): BodyRow[] {
  const body: BodyRow[] = [];
  rows.forEach((row, index) => {
    if (index === 0) {
      body.push({ kind: "header", text: "POPULAR" });
    } else if (row.other) {
      body.push({ kind: "blank" }, { kind: "header", text: "OTHER" });
    } else if (rows[index - 1].popular && !row.popular) {
      body.push({ kind: "blank" }, { kind: "header", text: "MORE CLIENTS" });
    }
    body.push({ kind: "option", index });
  });
  return body;
}

/**
 * Dependency-free raw-mode multiselect. Navigation keys move the cursor,
 * space toggles, `a` selects all clients, enter confirms, escape/ctrl+c cancels.
 */
export async function pickClients(options: PickerOption[]): Promise<PickerResult> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) {
    throw new Error("the client picker needs an interactive terminal");
  }

  const rows = [...options];
  const body = buildBodyRows(rows);
  const theme = createTheme(output);
  const columns = output.columns ?? 80;
  const terminalRows = output.rows ?? 24;
  const width = Math.max(44, Math.min(columns - 4, 64));
  const showDetail = columns >= 72;
  const detailLimit = Math.max(18, columns - 40);
  const rule = theme.dim("─".repeat(width));
  const footerHeight = rows.some((row) => row.detected) ? 3 : 4;
  const bodyHeight = Math.max(3, terminalRows - 4 - footerHeight);
  const hasDetected = rows.some((row) => row.detected);

  let cursor = 0;
  let painted = 0;
  let scrollStart = 0;
  let pageSize = bodyHeight;

  const renderRow = (row: PickerOption, index: number, final: boolean): string => {
    const pointer = final ? " " : index === cursor ? theme.bold(">") : " ";
    const box = row.selected ? theme.green("[*]") : theme.dim("[ ]");
    const label = row.label.padEnd(20);
    const tagName = row.detected ? "detected" : row.popular ? "popular" : "";
    const tag = tagName
      ? row.detected
        ? theme.green(tagName.padEnd(10))
        : theme.dim(tagName.padEnd(10))
      : " ".repeat(10);
    const detail = !showDetail
      ? ""
      : row.detail.length > detailLimit
        ? `${row.detail.slice(0, detailLimit - 1).trimEnd()}…`
        : row.detail;
    const styledLabel = index === cursor && !final ? theme.bold(label) : label;
    return `  ${pointer} ${box} ${styledLabel} ${tag} ${theme.dim(detail)}`.trimEnd();
  };

  const paint = (final = false): void => {
    const lines: string[] = [];
    const count = rows.filter((row) => !row.other && row.selected).length;
    const otherSelected = rows.some((row) => row.other && row.selected);

    lines.push(`  ${theme.bold("ZENFORGE")}  ${theme.dim("onboard")}`);
    lines.push(`  ${rule}`);
    lines.push(`  ${theme.dim("Connect ZenForge to the agents you use.")}`);
    lines.push("");

    const scrolling = body.length > bodyHeight;
    const visible = scrolling ? Math.max(1, bodyHeight - 2) : bodyHeight;
    pageSize = visible;
    const cursorLine = body.findIndex(
      (row) => row.kind === "option" && row.index === cursor
    );
    const window = scrollWindow(body.length, cursorLine, visible, scrollStart);
    scrollStart = window.start;

    if (scrolling) {
      lines.push(window.start > 0 ? `  ${theme.dim(`+${window.start} more above`)}` : "");
    }
    for (let index = window.start; index < window.end; index += 1) {
      const row = body[index];
      if (row.kind === "option") {
        lines.push(renderRow(rows[row.index], row.index, final));
      } else if (row.kind === "header") {
        lines.push(`  ${theme.dim(row.text)}`);
      } else {
        lines.push("");
      }
    }
    if (scrolling) {
      const below = body.length - window.end;
      lines.push(below > 0 ? `  ${theme.dim(`+${below} more below`)}` : "");
    }

    lines.push("");
    if (!hasDetected) {
      lines.push(
        `  ${theme.yellow("No clients detected.")} ${theme.dim(
          "Select one below or choose Other."
        )}`
      );
    }
    const selection =
      count > 0
        ? theme.green(`${count} selected${otherSelected ? " + other" : ""}`)
        : otherSelected
          ? theme.green("other client")
          : theme.dim("nothing selected");
    lines.push(`  ${selection}`);
    lines.push(
      final
        ? `  ${theme.dim("Selection confirmed.")}`
        : `  ${theme.dim(
            "up/down move · space toggle · a all · enter confirm · esc cancel"
          )}`
    );

    if (painted > 0) {
      output.write(`\u001b[${painted}A`);
      output.write("\u001b[0J");
    }
    output.write(`${lines.join("\n")}\n`);
    painted = lines.length;
  };

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write("\u001b[?25l");
  paint();

  return await new Promise<PickerResult>((resolve, reject) => {
    const cleanup = (): void => {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      output.write("\u001b[?25h");
    };
    const finish = (result: PickerResult): void => {
      cleanup();
      paint(true);
      resolve(result);
    };
    const onKey = (_value: string | undefined, key: Key): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        reject(new SelectionCancelled());
        return;
      }
      if (key.name === "escape") {
        cleanup();
        output.write("\n");
        reject(new SelectionCancelled());
        return;
      }
      switch (key.name) {
        case "up":
          cursor = moveCursor(rows, cursor, -1);
          break;
        case "down":
          cursor = moveCursor(rows, cursor, 1);
          break;
        case "pageup":
          cursor = moveCursor(rows, cursor, -pageSize);
          break;
        case "pagedown":
          cursor = moveCursor(rows, cursor, pageSize);
          break;
        case "home":
          cursor = 0;
          break;
        case "end":
          cursor = rows.length - 1;
          break;
        case "space":
        case "spacebar":
          rows[cursor] = { ...rows[cursor], selected: !rows[cursor].selected };
          break;
        case "a":
          if (!key.ctrl && !key.meta && rows.length > 0) {
            const allClients = rows.filter((row) => !row.other);
            const selected = !allClients.every((row) => row.selected);
            rows.splice(0, rows.length, ...toggleAll(rows, selected));
          }
          break;
        case "return":
        case "enter":
          finish(pickerResult(rows));
          return;
        default:
          break;
      }
      paint();
    };
    input.on("keypress", onKey);
  });
}
