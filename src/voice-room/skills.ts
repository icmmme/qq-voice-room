import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RoomSkillName = "deep-link-analysis" | "deep-tech-qa" | "casual-chat";

const FALLBACK_SKILLS: Readonly<Record<RoomSkillName, string>> = Object.freeze({
  "deep-link-analysis": [
    "目标体量 450～900 字、3～4 个高密度自然段（短推文可精简到 2～3 段）。",
    "第 1 段直接给核心判断；第 2～4 段用「第一」「第二」「第三」深挖 2～3 个最硬核的机制、反常识点或工程权衡，不按原文目录写流水账。",
    "严禁套话（本文介绍了/综上所述/总的来说/值得注意的是），严禁堆砌 Markdown 标题或加粗清单，严格基于抓到的原文事实。",
  ].join("\n"),
  "deep-tech-qa": [
    "目标体量 400～850 字、3～4 个高密度自然段。",
    "第 1 段先给核心结论；后续用「第一」「第二」「第三」拆解 2～3 个最关键的因果、坑点或方案取舍，说明边界条件。",
    "严禁教科书定义背诵、空洞套话与 Markdown 标题堆砌。",
  ].join("\n"),
  "casual-chat": "自然简短像真人说话，优先 1 段（最多 2 段），不为凑数补第二段，不端着、不输出动作旁白或角色名前缀。",
});

const cache = new Map<string, { mtimeMs: number; content: string }>();

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

/**
 * Load a room response skill markdown file with mtime hot-reload.
 * Editing `skills/*.md` takes effect on the next turn without restarting or rebuilding.
 */
export function loadRoomSkill(name: RoomSkillName, skillsDir = resolveSkillsDir()): string {
  const file = resolve(skillsDir, `${name}.md`);
  try {
    const stat = statSync(file);
    if (stat.size > 32 * 1024) return FALLBACK_SKILLS[name];
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
    const raw = readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trim();
    if (!raw || raw.includes("\0")) return FALLBACK_SKILLS[name];
    cache.set(file, { mtimeMs: stat.mtimeMs, content: raw });
    return raw;
  } catch {
    return FALLBACK_SKILLS[name];
  }
}

export function selectRoomSkill(input: { deep: boolean; hasWebEvidence: boolean; hasUrls: boolean }): RoomSkillName {
  if (!input.deep) return "casual-chat";
  return input.hasWebEvidence || input.hasUrls ? "deep-link-analysis" : "deep-tech-qa";
}
