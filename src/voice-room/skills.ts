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
    description: "Read shared links, repos, X posts, and meme pages with intent triage: punchy banter for memes/drama, sharp Analytical Lens breakdowns for serious tech articles.",
    body: [
      "先看气氛与意图再定篇幅：乐子/整活/吐槽链接 1-2 段（120-320 字）先接梗抓最荒诞细节吐槽，严禁写成四段长评或安全说教；短帖/X 动态 1-3 段；硬核长文/开源仓库 3-4 段（450-900 字）。",
      "## Analytical Lens（硬核拆解视角）",
      "处理硬核长文时用三个问题筛一遍材料——真问题与核心判断、关键机制、代价与盲区；保持角色本色，不写总-分-总，禁用“综上所述/总的来说/值得注意的是/作为AI”等套话。",
      "所有事实严格锚定 webEvidence（及补充 web_fetch 原文），未抓全或被截断时坦诚说明，绝不编造。",
    ].join("\n"),
  },
  "deep-tech-qa": {
    description: "Answer tech questions and recent drama/news with intent triage, bilingual web search, upfront verdicts, and natural QQ group personality.",
    body: [
      "先分场景再定长短：吃瓜/热点 1-3 段（180-450 字）直讲谁干了啥和槽点；硬核技术问答 2-4 段（350-850 字）用 Analytical Lens 先亮判断、抓准机制与坑点、交代具体边界。",
      "遇到海外项目、开源工具或 X/Reddit 讨论，不要只搜中文关键词，主动用英文项目名+社区词（drama/controversy/reddit/hackernews/twitter）做 web_search，必要时 web_fetch 一手原文；查不到坦诚说没查到，绝不编造。",
      "贴合角色本色，讲透即收尾不凑总结段，禁用“综上所述/总的来说/值得注意的是/作为AI/希望以上回答对你有帮助”等套话。",
    ].join("\n"),
  },
  "casual-chat": {
    description: "Keep everyday QQ group chat brief, natural, witty, and genuinely in-character without robotic clichés or constant lecturing.",
    body: "像真实 QQ 群里熟人接茬：人设和脾气排第一，先接情绪与玩梗、少用“不过/但是”泼冷水；默认 1 句，真有包袱再分 2 句；遇到短句卖关子或没图时用角色口吻随口打趣，严禁客服工单腔，不写旁白前缀，禁用“综上所述/总的来说/值得注意的是/作为AI”。",
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
