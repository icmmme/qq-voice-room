import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function gitBlobSha1(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
