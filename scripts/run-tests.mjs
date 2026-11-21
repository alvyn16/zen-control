import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const dir = process.argv[2] ?? "test/unit";
const flags = process.argv.slice(3);

function walk(path) {
  const out = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const files = walk(dir).sort();
if (files.length === 0) {
  console.error(`No test files found under ${dir}`);
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...flags, ...files.map((f) => relative(process.cwd(), f))],
  { stdio: "inherit" }
);
process.exit(result.status ?? 1);
