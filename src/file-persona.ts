import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

/** One editable Markdown file is the only persona source in file mode. */
export const MAX_FILE_PERSONA_BYTES = 64 * 1024;
export const MAX_FILE_PERSONA_NAME = 80;

export type FilePersonaErrorCode =
  | "invalid-id" | "missing" | "not-file" | "unreadable"
  | "too-large" | "empty" | "encoding" | "no-title" | "title-empty" | "title-too-long";

const MESSAGES: Record<FilePersonaErrorCode, string> = {
  "invalid-id": "人设 ID 必须是 1–64 位 ASCII 字母、数字、_ 或 -，且不能是 Windows 保留名。",
  missing: "人设文件不存在，请检查本地人设文件配置。",
  "not-file": "人设路径不是普通文件，请检查本地人设文件配置。",
  unreadable: "无法读取人设文件，请检查文件路径和读取权限。",
  "too-large": "人设文件超过 64 KiB 上限，请精简后再试。",
  empty: "人设文件为空，请添加一级标题和角色内容。",
  encoding: "人设文件必须使用 UTF-8 编码。",
  "no-title": "人设文件缺少第一个一级标题（# 名称），请先补充标题。",
  "title-empty": "人设一级标题不能为空。",
  "title-too-long": `人设一级标题最多 ${MAX_FILE_PERSONA_NAME} 个字符。`,
};

/** A fixed error: messages never include paths, file contents or lower-level exception text. */
export class FilePersonaError extends Error {
  constructor(readonly code: FilePersonaErrorCode) {
    super(MESSAGES[code]);
    this.name = "FilePersonaError";
  }
}

export interface FilePersonaSnapshot {
  id: string;
  name: string;
  /** The complete Markdown document, without an optional UTF-8 BOM. */
  content: string;
  stylePersonaHash: string;
}

const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function normalizePersonaId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(id) || RESERVED_WINDOWS_NAME.test(id)) {
    throw new FilePersonaError("invalid-id");
  }
  return id;
}

function cleanHeading(raw: string): string {
  let value = raw.trim().replace(/[ \t]+#+[ \t]*$/, "").trim();
  const link = /^\[([^\]]+)\]\([^)]*\)$/.exec(value);
  if (link) value = link[1]!.trim();
  const code = /^(`+)([\s\S]*?)\1$/.exec(value);
  if (code) value = code[2]!.trim();
  for (let round = 0; round < 3; round++) {
    const emphasis = /^([*_~])([\s\S]*?)\1$/.exec(value);
    if (!emphasis) break;
    value = emphasis[2]!.trim();
  }
  return value.replace(/<[^>]{1,200}>/g, "").trim();
}

function firstLevelOneHeading(text: string): { found: boolean; value: string } {
  const lines = text.split(/\r?\n/);
  let fence: { marker: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      const length = fenceMatch[1]!.length;
      if (!fence) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^ {0,3}#(?!#)(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
    if (atx) return { found: true, value: cleanHeading(atx[1] ?? "") };
    if (!line.trim() || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) continue;
    const next = lines[index + 1];
    if (next && /^ {0,3}=+[ \t]*$/.test(next)) return { found: true, value: cleanHeading(line) };
  }
  return { found: false, value: "" };
}

/** Read one complete snapshot. Size and UTF-8 checks happen before Markdown parsing. */
export function readFilePersona(file: string, id: string): FilePersonaSnapshot {
  let info;
  try { info = statSync(file); }
  catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    throw new FilePersonaError(code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable");
  }
  if (!info.isFile()) throw new FilePersonaError("not-file");
  if (info.size > MAX_FILE_PERSONA_BYTES) throw new FilePersonaError("too-large");
  let bytes: Buffer;
  try { bytes = readFileSync(file); }
  catch { throw new FilePersonaError("unreadable"); }
  if (bytes.length > MAX_FILE_PERSONA_BYTES) throw new FilePersonaError("too-large");
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, ""); }
  catch { throw new FilePersonaError("encoding"); }
  if (!content.trim()) throw new FilePersonaError("empty");
  const heading = firstLevelOneHeading(content);
  if (!heading.found) throw new FilePersonaError("no-title");
  if (!heading.value) throw new FilePersonaError("title-empty");
  if ([...heading.value].length > MAX_FILE_PERSONA_NAME) throw new FilePersonaError("title-too-long");
  const normalizedId = normalizePersonaId(id);
  const stylePersonaHash = createHash("sha256").update(`file:v1\0${normalizedId}\0`).update(bytes).digest("hex");
  return { id: normalizedId, name: heading.value, content, stylePersonaHash };
}
