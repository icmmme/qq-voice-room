#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateArchitecture } from "./lib/architecture-guard.mjs";
import { sha256Bytes } from "./lib/hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function collect(directory, suffix) {
  const results = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collect(absolute, suffix)));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      const bytes = await readFile(absolute);
      results.push({
        path: path.relative(root, absolute).replaceAll("\\", "/"),
        content: bytes.toString("utf8"),
        sha256: sha256Bytes(bytes)
      });
    }
  }
  return results;
}

const files = [
  ...(await collect(path.join(root, "src"), ".ts")),
  ...(await collect(path.join(root, "tools"), ".mjs")),
  ...(await collect(path.join(root, "tests", "foundation"), ".mjs"))
];
const baseline = JSON.parse(await readFile(path.join(root, "evidence", "architecture-baseline.json"), "utf8"));
const result = evaluateArchitecture({ files, baseline });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exit(1);
