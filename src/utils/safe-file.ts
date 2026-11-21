import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // Windows does not apply POSIX mode bits; best effort.
  }
}

/** Refuse to follow a symlink or overwrite a special file. */
export function assertWritableTarget(target: string): void {
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${target}`);
  if (!stat.isFile()) throw new Error(`Refusing to write non-regular file: ${target}`);
}

/**
 * Write via an unpredictable O_EXCL temp file in the same directory, fsync,
 * then rename over the target. A pre-planted symlink cannot redirect the write.
 */
export function atomicWritePrivate(target: string, text: string): void {
  ensurePrivateDir(dirname(target));
  assertWritableTarget(target);
  const temp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", PRIVATE_FILE_MODE);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
    try {
      chmodSync(target, PRIVATE_FILE_MODE);
    } catch {
      // best effort on Windows
    }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(temp); } catch { /* never created */ }
    throw error;
  }
}

export function readFileTextBounded(file: string, maxBytes: number): string {
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a regular file.`);
  if (stat.size > maxBytes) throw new Error(`${file} exceeds the ${maxBytes}-byte budget.`);
  return readFileSync(file, "utf8");
}
