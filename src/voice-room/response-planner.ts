import type { ResponseBudgets, ResponseField, ResponseFields, ResponsePlan, ResponseTier } from "./types.js";

export const RESPONSE_ENUMS = Object.freeze({
  intent: ["chat", "explain", "analyze", "advise"], depth: ["brief", "standard", "detailed"],
  rigor: ["casual", "careful"], tone: ["casual", "formal"], personaIntensity: ["normal", "restrained"],
} as const);
export const RESPONSE_FIELDS = Object.freeze(Object.keys(RESPONSE_ENUMS) as ResponseField[]);
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Only five descriptive enums can cross the assistance boundary. Never role/order/permission. */
export function validAssistance(value: unknown, unresolved: readonly ResponseField[]): value is Partial<ResponseFields> {
  if (!record(value) || !Object.keys(value).length || Object.keys(value).some(k => !unresolved.includes(k as ResponseField))) return false;
  return Object.entries(value).every(([k, v]) => typeof v === "string" && (RESPONSE_ENUMS[k as ResponseField] as readonly string[]).includes(v));
}
export function validResponsePlan(value: unknown): value is ResponsePlan {
  if (!record(value) || Object.keys(value).sort().join(",") !== "assistance,budget,depth,intent,personaIntensity,planId,rigor,sources,tier,tone"
    || typeof value.planId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.planId)
    || !RESPONSE_FIELDS.every(k => (RESPONSE_ENUMS[k] as readonly unknown[]).includes(value[k]))
    || !["daily", "formal", "detailed"].includes(String(value.tier))
    || !["not_needed", "used", "unavailable", "error", "timeout", "invalid"].includes(String(value.assistance))
    || !record(value.sources) || Object.keys(value.sources).sort().join(",") !== [...RESPONSE_FIELDS].sort().join(",")
    || !Object.values(value.sources).every(v => ["requested", "inferred", "approved_default"].includes(String(v)))
    || !record(value.budget) || Object.keys(value.budget).sort().join(",") !== "maxTextChars,outputTokens"
    || !Object.values(value.budget).every(n => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 1_000_000)) return false;
  return true;
}
/** Deterministic rules annotate actual evidence; this is not a quality or factuality evaluator. */
export function ruleResponsePlan(text: string, budgets: ResponseBudgets, planId: string): ResponsePlan {
  const formal = /代码|技术|工程|算法|证明|故障|方案|分析|解释|如何|为什么|数学|code|explain|analy[sz]e|formal|rigorous/i.test(text);
  const fields: ResponseFields = { intent: formal ? "explain" : "chat", depth: formal ? "standard" : "brief",
    rigor: formal ? "careful" : "casual", tone: formal ? "formal" : "casual", personaIntensity: formal ? "restrained" : "normal" };
  const sources: Record<ResponseField, ResponsePlan["sources"][ResponseField]> = {
    intent: formal ? "inferred" : "approved_default", depth: "approved_default", rigor: "approved_default",
    tone: "approved_default", personaIntensity: "approved_default",
  };
  const mutable = { ...fields };
  const set = <K extends ResponseField>(key: K, value: ResponseFields[K]) => { mutable[key] = value; sources[key] = "requested"; };
  if (/请.*(?:解释|说明)|解释一下|explain\b/i.test(text)) set("intent", "explain");
  if (/请.*分析|分析一下|analy[sz]e\b/i.test(text)) set("intent", "analyze");
  if (/请.*建议|给.*建议|recommend\b/i.test(text)) set("intent", "advise");
  if (/随便聊|聊聊天|just chat/i.test(text)) set("intent", "chat");
  if (/详细|展开讲|完整步骤|in detail|detailed/i.test(text)) set("depth", "detailed");
  // A direct brevity request takes precedence over a generic detailed-topic phrase.
  if (/简短|一句话|简要|brief|concise/i.test(text)) set("depth", "brief");
  if (/严谨|认真|依据|rigorous/i.test(text)) set("rigor", "careful");
  if (/随意|不用严肃|casually/i.test(text)) set("rigor", "casual");
  if (/正式|专业语气|formal/i.test(text)) set("tone", "formal");
  if (/轻松|口语|casual tone/i.test(text)) set("tone", "casual");
  if (/少.*人设|克制|不要卖萌|restrained/i.test(text)) set("personaIntensity", "restrained");
  if (/保留人设|角色语气|可爱一点|in character/i.test(text)) set("personaIntensity", "normal");
  const tier: ResponseTier = sources.depth === "requested" && mutable.depth === "detailed" ? "detailed"
    : sources.depth === "requested" && mutable.depth === "brief" ? "daily"
    : formal || mutable.rigor === "careful" || mutable.tone === "formal" ? "formal" : "daily";
  return Object.freeze({ ...mutable, planId, sources: Object.freeze(sources), tier,
    budget: budgets[tier], assistance: Object.values(sources).includes("requested") ? "not_needed" : "unavailable" });
}
export function unresolvedFields(plan: ResponsePlan): readonly ResponseField[] {
  // Clear user requests are fully handled by rules + approved defaults (zero auxiliary calls).
  return plan.assistance === "not_needed" ? Object.freeze([]) : Object.freeze(RESPONSE_FIELDS.filter(k => plan.sources[k] !== "requested"));
}
export function completeResponsePlan(rule: ResponsePlan, budgets: ResponseBudgets, assistance: ResponsePlan["assistance"], candidate?: unknown): ResponsePlan {
  if (rule.assistance === "not_needed") return rule;
  const unresolved = unresolvedFields(rule);
  if (assistance !== "used") return Object.freeze({ ...rule, assistance });
  if (!validAssistance(candidate, unresolved)) return Object.freeze({ ...rule, assistance: "invalid" });
  const fields = Object.fromEntries(RESPONSE_FIELDS.map(k => [k, candidate[k] ?? rule[k]])) as unknown as ResponseFields;
  const sources = Object.freeze(Object.fromEntries(RESPONSE_FIELDS.map(k => [k, candidate[k] === undefined ? rule.sources[k] : "inferred"])) as Record<ResponseField, ResponsePlan["sources"][ResponseField]>);
  // The 2000/4096 tier requires an explicit user request, never model-granted authority.
  const tier: ResponseTier = rule.tier === "detailed" ? "detailed" : rule.sources.depth === "requested" ? rule.tier
    : fields.depth !== "brief" || fields.rigor === "careful" || fields.tone === "formal" || fields.intent !== "chat" ? "formal" : "daily";
  return Object.freeze({ ...fields, planId: rule.planId, sources, tier, budget: budgets[tier], assistance });
}
export function checkedWorkerAnswer(value: unknown, maxChars: number): { kind: "reply"; text: string } | { kind: "skip" } | null {
  if (!record(value)) return null;
  if (value.kind === "skip" && Object.keys(value).join(",") === "kind") return { kind: "skip" };
  if (value.kind !== "reply" || Object.keys(value).sort().join(",") !== "kind,text" || typeof value.text !== "string"
    || !value.text.trim() || value.text.includes("\0") || [...value.text].length > maxChars) return null;
  return { kind: "reply", text: value.text };
}
