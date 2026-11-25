import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RoomSkillName = "deep-link-analysis" | "deep-tech-qa" | "casual-chat";

export interface RoomSkillMeta {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

interface CachedSkill {
  readonly mtimeMs: number;
  readonly meta: RoomSkillMeta;
  readonly body: string;
}

const FALLBACK_SKILLS: Readonly<Record<RoomSkillName, { description: string; body: string }>> = Object.freeze({
  "deep-link-analysis": {
    description: "Synthesize shared links with sharp judgment, concrete mechanisms, and trade-offs.",
    body: [
      "Filter the source through three questions: what real claim/misconception it addresses, what concrete mechanism makes it work, and what trade-off or blind spot matters.",
      "Default to 3-4 tight paragraphs (~450-900 chars for essays, ~250-500 for short X posts). Open with your core judgment; prioritize the 2-3 highest-leverage points over section-by-section summaries.",
      "Follow explicit user format/depth requests if given. Ground all facts strictly in webEvidence.",
    ].join("\n"),
  },
  "deep-tech-qa": {
    description: "Answer complex questions with direct verdicts, failure modes, and concrete boundaries.",
    body: [
      "Lead with the verdict in 1-2 sentences, then unpack the 2-3 hardest failure modes, causal mechanisms, or concrete trade-off boundaries.",
      "Default to 3-4 compact paragraphs (~400-850 chars) in the character's natural voice. Follow explicit user format requests if given.",
    ].join("\n"),
  },
  "casual-chat": {
    description: "Keep everyday group chat brief, natural, and in-character.",
    body: "Respond concisely and naturally in character (1 line by default, at most 2); match the group's tone without lecturing, stage actions, or name prefixes.",
  },
});

const cache = new Map<string, CachedSkill>();

function resolveSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "skills"),       // src/voice-room -> repo/skills
    resolve(here, "..", "..", "..", "skills"), // dist/src/voice-room -> repo/skills (or release/app/skills)
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

/** Parse lightweight Agent Skills YAML frontmatter (`--- ... ---`) without external deps. */
function parseSkillMarkdown(raw: string, fallbackName: string, filePath: string): { meta: RoomSkillMeta; body: string } {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!fmMatch) {
    return {
      meta: Object.freeze({ name: fallbackName, description: "", path: filePath }),
      body: normalized,
    };
  }
  const fields: Record<string, string> = {};
  for (const line of fmMatch[1]!.split("\n")) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
    if (!kv) continue;
    const value = kv[2]!.trim().replace(/^["']|["']$/g, "");
    fields[kv[1]!] = value;
  }
  return {
    meta: Object.freeze({
      name: fields.name || fallbackName,
      description: fields.description || "",
      path: filePath,
    }),
    body: fmMatch[2]!.trim(),
  };
}

function readSkillFile(filePath: string, fallbackName: string): CachedSkill | null {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > 32 * 1024) return null;
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim() || raw.includes("\0")) return null;
    const parsed = parseSkillMarkdown(raw, fallbackName, filePath);
    if (!parsed.body) return null;
    const entry: CachedSkill = Object.freeze({ mtimeMs: stat.mtimeMs, ...parsed });
    cache.set(filePath, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Progressive-disclosure Layer 1: discover available skills (name + 1-line description only)
 * following the Agent Skills open standard (`skills/<name>/SKILL.md`).
 */
export function listRoomSkills(skillsDir = resolveSkillsDir()): readonly RoomSkillMeta[] {
  const results: RoomSkillMeta[] = [];
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skillFile = resolve(skillsDir, entry.name, "SKILL.md");
        const loaded = readSkillFile(skillFile, entry.name);
        if (loaded) results.push(loaded.meta);
      }
    }
  } catch { /* Return empty when skillsDir is absent. */ }
  return Object.freeze(results);
}

/**
 * Progressive-disclosure Layer 2: load one matched skill's body with mtime hot-reload.
 * Supports open-standard `skills/<name>/SKILL.md` and flat `skills/<name>.md` fallback.
 */
export function loadRoomSkill(name: RoomSkillName, skillsDir = resolveSkillsDir()): string {
  const folderPath = resolve(skillsDir, name, "SKILL.md");
  const flatPath = resolve(skillsDir, `${name}.md`);
  const loaded = readSkillFile(folderPath, name) ?? readSkillFile(flatPath, name);
  const body = loaded?.body ?? FALLBACK_SKILLS[name].body;
  return `<skill name="${name}">\n${body}\n</skill>`;
}

export function selectRoomSkill(input: { deep: boolean; hasWebEvidence: boolean; hasUrls: boolean }): RoomSkillName {
  if (!input.deep) return "casual-chat";
  return input.hasWebEvidence || input.hasUrls ? "deep-link-analysis" : "deep-tech-qa";
}
