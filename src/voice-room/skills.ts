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
    description: "Synthesize shared web pages, technical essays, GitHub repos, or X posts with sharp judgment, concrete mechanisms, and real trade-offs in a natural QQ group voice.",
    body: [
      "## Analytical Lens（拆解视角）",
      "像群里懂行的熟人一样直接切中要害：先用三个问题筛一遍材料——作者到底在解决什么真问题、靠什么具体机制跑通、在什么边界下会失效或有什么代价。",
      "默认 3-4 段高密度短文（长文约 450-900 字，短 X 帖 2-3 段约 250-500 字）：开头 1-2 句先抛核心判断，只讲最关键的 2-3 个要点，不按小节流水账复述；显式用户格式/深度要求优先。保持角色本色和群聊口语质感，禁用“综上所述/总的来说/值得注意的是/作为AI”等套话。",
      "所有事实严格锚定 webEvidence（及补充 web_fetch 原文），未抓全或被截断时坦诚说明，绝不编造。",
    ].join("\n"),
  },
  "deep-tech-qa": {
    description: "Answer complex technical, recent, or factual questions in a natural QQ group voice with upfront verdicts, causal failure modes, concrete boundaries, and honest web tool grounding.",
    body: [
      "像群里懂行靠谱的老熟人那样直接给判断：开头 1-2 句先抛核心结论或根因，再挑 2-3 个最硬核的机制、失效模式与具体边界展开（说清什么时候选 A、何时换 B），别套固定模板。",
      "默认 3-4 段紧凑口语化表达（约 400-850 字），保持角色本色，禁用“综上所述/总的来说/值得注意的是/作为AI”等公文腔或客服腔；显式用户格式要求优先。",
      "涉及最新动态或外部核实时，可用 web_search 先查、必要时用 web_fetch 读原文；无搜索工具时绝不声称已联网搜索；检索失败或无结果时坦诚说明，绝不编造来源或日期。",
    ].join("\n"),
  },
  "casual-chat": {
    description: "Keep everyday QQ group chat brief, natural, spoken, and in-character without padding or robotic clichés.",
    body: "像真实 QQ 群里熟人自然接茬：简短、松弛、有口语质感，保持角色本色不端着；默认 1 句（最多 2 句，绝不硬凑第二段），不写动作旁白或角色名前缀，禁用“综上所述/总的来说/值得注意的是/作为AI”等套话。",
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
