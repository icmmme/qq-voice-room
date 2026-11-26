import type { CheckedRoomConfig } from "./config.js";
import type { RoomCharacter, RoomMessage } from "./types.js";

export type ParticipationReason = "disabled" | "paused" | "stopped" | "busy" | "no-input" | "quiet"
  | "cooldown" | "offline" | "budget" | "other-conversation" | "trivial" | "repetition"
  | "recent-bots" | "no-signal" | "named-question" | "group-question" | "public-question"
  | "follow-up" | "share" | "named-mention" | "open-question" | "natural-topic";
export interface ParticipationNotice { shouldReply: boolean; reason: ParticipationReason; maxTurns: 0 | 1 | 2 }
export type ParticipationDecision = ParticipationNotice & { firstSpeaker?: string };
export interface ParticipationContext {
  history: readonly RoomMessage[];
  pendingIds: readonly number[];
  now: number;
  observedAt: number;
  lastAttemptAt: number | null;
  online: ReadonlySet<string>;
  paused: boolean;
  stopped: boolean;
  busy: boolean;
  blockedTarget: boolean;
  hasBudget: boolean;
}

const FOLLOW_UP_MS = 120000;
const MAX_RECENT_BOT_TURNS = 2;
const COMMON_ALIASES: Readonly<Record<string, readonly string[]>> = { luna: ["露娜"], rin: ["凛"] };
const question = /[?？]|怎么看|觉得|怎么样|喜欢|建议|推荐|能不能|要不要|聊聊|说说|为什么|怎么选|如何|怎么办/;
const publicAddress = /大家|你们|两位|各位|有没有人|有人知道|谁知道/;
const bothViews = /各自|分别|各说|都说|不同意见|比较一下/;
const followUp = /^(那|所以|然后|还有|可是|但是|为什么|怎么|这个|这件|这点)|你刚才|刚才说/;
const continuation = /^(?:(?:继续|接着)(?:说(?:下去)?|讲(?:下去)?|吧|聊聊|解释|展开|详细)?|展开说|详细说|再多说|然后呢|还有呢)(?:[。！？!?]+)?$/u;
const quotedQuestionEnd = /[？?][！!]*\s*$/u;
const directInterrogativeOpening = /^(?:(?:你|您)?(?:为什么|怎么|如何|能不能|可不可以|要不要|是否|谁|什么|哪儿|哪里|多少|几))/u;
const performativeQuestionOpening = /^(?:请问(?:一下|下)?|麻烦请问(?:一下|下)?|我(?:只是|就是|其实)?(?:想知道(?:一下|下)?|想了解(?:一下|下)?|想确认(?:一下|下)?|想请教(?:一下|下)?|想问(?:一下|下)?|问你(?:一下|下)?)|我想问(?:一下|下)?|我想请问(?:一下|下)?|我想知道(?:一下|下)?|想问(?:一下|下)?|想了解(?:一下|下)?|想确认(?:一下|下)?|想请教(?:一下|下)?|麻烦问(?:一下|下)?|顺便问(?:一下|下)?|再问(?:一下|下)?|问(?:一下|下)|问问|问你(?:一下|下)?|我问你|有个问题|我(?:也)?问一句|我好奇问一句|(?:请|麻烦)?(?:告诉我|说说(?:看)?|说一下?|说下|讲讲|讲一下|讲下|解释(?:一下|下)?|说明(?:一下|下)?|展开(?:一下|下)?|补充(?:一下|下)?|问一句)|(?:能|可以|能不能|可不可以)?(?:再|详细|具体)?(?:说说(?:看)?|说一下?|说下|讲讲|讲一下?|讲下|解释一下?|说明一下?|展开一下?|补充一下?)|请(?:再|详细|具体)?(?:说说(?:看)?|说一下?|说下|讲讲|讲一下?|讲下|解释(?:一下|下)?|说明(?:一下|下)?|展开(?:一下|下)?|补充(?:一下|下)?)|麻烦(?:再|详细|具体)?(?:说说(?:看)?|说一下?|说下|讲讲|讲一下?|讲下|解释(?:一下|下)?|说明(?:一下|下)?|展开(?:一下|下)?|补充(?:一下|下)?))/u;
const personalQuestionOpening = /^(?:我(?:这边|这里|现在|目前)?(?:只是|就是|其实|还|也)?(?:有(?:一个|个|些)?(?:问题|疑问)|想(?:再|还)?(?:问|请教|确认|了解|知道)(?:一下|下|一句|一个?问题|个问题|个疑问)?|(?:再|还)?问(?:一下|下|一句|一个?问题|个问题|个疑问)?|好奇问(?:一下|下|一句)?)|我问你(?:一下|下)?|(?:请|麻烦(?:你)?|你?(?:能不能|可不可以|能|可以))?(?:帮我|帮忙)(?:问|请教|确认|了解|查|看看?|核对)(?:一下|下|一句)?|打扰(?:一下|下)?|不好意思(?:打扰(?:一下|下)?|问(?:一下|下|一句)?)?|有个问题)/u;
const reportedTitleLine = /(?:标题|题目|主题|口号|字样|文字|内容|名称|名字)[^\r\n：:]*[：:]/u;
const reportedSpeech = /(?:问|说|读|念|播报|引用|写|记录|显示)(?:了|了一句|道|道了|着|剧本|台词)?[^\r\n：:]*[：:]/u;
const quotedFollowUp = /^(?:请(?:你)?|麻烦(?:你)?)(?:解释|说明|展开|补充)(?:一下|下)?(?:[^，,。！？!?：:\0]{1,40})?[。！!]?$/u;
const selfIntroduction = /^(?:(?:大家好|先做个自我介绍|自我介绍一下|简单介绍一下|先说一下)[，,]?\s*)?我(?:是|叫)([\p{Script=Han}]{1,6}|[A-Za-z][A-Za-z0-9_-]{1,15})(?=$|[\s，,:：。！？!?])/u;
const reportedDialogue = /(?:剧本|台词|对白|独白|场记|分镜|演员念|旁白|第\s*[一二三四五六七八九十百零〇0-9]+\s*(?:场|幕|景))/u;
const reportedDialogueLabel = /^(?:[^\r\n]*)(?:剧本|台词|对白|对话|独白|场记|分镜|话剧|舞台剧|情景剧|脚本|字幕|旁白|演员念)[^\r\n：:]*[：:]/mu;
const reportedSceneLabel = /(?:第\s*[一二三四五六七八九十百零〇0-9]+\s*(?:场|幕|景)[^\r\n：:]*[：:]|第\s*[一二三四五六七八九十百零〇0-9]+\s*(?:场|幕|景)\s*(?:[）)])?\s*$)/mu;
const colonLike = "：:﹕︓∶꞉׃፡፥ꘌ⁚︰܃܄܅܆܇܈܉፦᠄⁝⦂⩴⫶꛴𒑱𒑲𒑳𒑴𝪊˸";
const addressPreamble = /(?:谢谢你|麻烦|劳驾|请|帮我|帮忙|(?:顺便|我想|想)?问(?:一下|下)?)[\s，,、；;]*/uy;
const addressConnector = /[你您](?!们)[\s，,、；;]*/uy;
const addressTarget = new RegExp(
  `([^\\s，,${colonLike}]{1,16})\\s*[，,${colonLike}]\\s*(你(?!们))?`,
  "uy",
);
const reportedSpeakerLine = new RegExp(`^[^\\r\\n${colonLike}]+[${colonLike}]`, "mu");
const reportedSpeakerBlock = new RegExp(`^[^\\r\\n${colonLike}]+[${colonLike}]\\s*$`, "mu");
const sharing = /(?:今天|刚刚|刚才|终于|最近).{0,40}(?:完成|搞定|做完|跑通|拿到|学会|通过|发现|做了|去了|买了|吃了|看了|听了)/;
const normalize = (s: string) => s.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
const trivialReaction = /^(?:嗯+|哦+|啊+|好+|哈+|呵+|嘻+|嘿+|收到(?:收到)?|谢谢(?:谢谢|啦|了)?|好的|好哒|好滴|行吧|行行行|ok+|yes|no|666+|233+|笑死|确实|懂了|明白了?)$/i;
const silence = (reason: ParticipationReason): ParticipationDecision => ({ shouldReply: false, reason, maxTurns: 0 });

function normalizeAddressText(text: string): string {
  return text.replace(/\p{Cf}/gu, "").replace(/\p{White_Space}+/gu, " ").trim();
}

function introducedMemberNames(history: readonly RoomMessage[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const message of history) {
    if (message.speakerType !== "user") continue;
    const text = normalizeAddressText(message.text);
    if (reportedDialogue.test(text)) continue;
    const name = selfIntroduction.exec(text)?.[1];
    if (name) names.add(name.toLocaleLowerCase());
  }
  return names;
}

function findExplicitAddress(text: string, history: readonly RoomMessage[]): string | undefined {
  let introduced: ReadonlySet<string> | undefined;
  let explicitTarget: string | undefined;
  for (let offset = 0; offset < text.length;) {
    addressTarget.lastIndex = offset;
    const [, target, secondPerson] = addressTarget.exec(text) ?? [];
    if (target) {
      introduced ??= introducedMemberNames(history);
      // A known name can itself start with a preamble word.
      if (introduced.has(target.toLocaleLowerCase())) return target;
      explicitTarget = secondPerson ? target : undefined;
    }

    addressPreamble.lastIndex = offset;
    if (!addressPreamble.test(text)) {
      // A connector links two preamble tokens. Otherwise it may be part of the target.
      addressConnector.lastIndex = offset;
      if (offset === 0 || !addressConnector.test(text)) break;
      addressPreamble.lastIndex = addressConnector.lastIndex;
      if (!addressPreamble.test(text)) break;
    }
    offset = addressPreamble.lastIndex;
  }
  return explicitTarget;
}

function stripDirectQuestionOpenings(text: string): { text: string; matched: boolean } {
  let remaining = text;
  let matched = false;
  for (let index = 0; index < 3; index++) {
    const opening = personalQuestionOpening.exec(remaining)?.[0]
      ?? performativeQuestionOpening.exec(remaining)?.[0];
    if (opening === undefined) break;
    matched = true;
    remaining = remaining.slice(opening.length).replace(/^[\s\p{P}\p{S}]+/u, "");
  }
  return { text: remaining, matched };
}

/** A quote is a continuation only when its text asks or explicitly follows the quoted turn. */
export function isQuotedContinuation(text: string): boolean {
  const trimmed = text.replace(/\p{Cf}/gu, "").replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
  const clearQuestion = quotedQuestionEnd.test(trimmed) && [...normalize(trimmed)].length >= 2;
  const lines = trimmed.split(/\r\n|[\n\r\u0085\u2028\u2029]/u);
  const questionLine = (lines.at(-1) ?? trimmed).trimStart();
  const earlierText = lines.slice(0, -1).join("\n");
  const strippedOpening = stripDirectQuestionOpenings(questionLine);
  const questionWithoutOpening = strippedOpening.text;
  const normalizedQuestion = questionWithoutOpening.replace(/^[\s，,:：、]+/u, "");
  const questionLineReported = reportedTitleLine.test(normalizedQuestion)
    || reportedSpeech.test(normalizedQuestion)
    || reportedDialogueLabel.test(normalizedQuestion)
    || reportedSceneLabel.test(normalizedQuestion)
    || reportedSpeakerLine.test(normalizedQuestion);
  const earlierTextReported = reportedSpeech.test(earlierText)
    || reportedDialogueLabel.test(earlierText)
    || reportedSceneLabel.test(earlierText)
    || reportedSpeakerBlock.test(earlierText);
  const directQuestion = directInterrogativeOpening.test(normalizedQuestion)
    || (!questionLineReported
      && (strippedOpening.matched || !earlierTextReported));
  return (clearQuestion && directQuestion)
    || quotedFollowUp.test(trimmed) || continuation.test(trimmed);
}

/** Pure, conservative rules. No model calls, clocks, persistence or random speaker selection. */
export class ParticipationPolicy {
  constructor(private readonly config: CheckedRoomConfig) {}

  private named(text: string, c: RoomCharacter): boolean {
    const common = Object.hasOwn(COMMON_ALIASES, c.id) ? COMMON_ALIASES[c.id]! : [];
    const configured = Object.hasOwn(this.config.participation.aliases, c.id) ? this.config.participation.aliases[c.id]! : [];
    const aliases = [c.name, c.id, ...common, ...configured];
    return aliases.some(alias => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if ([...alias].length === 1 && /\p{Script=Han}/u.test(alias)) {
        return new RegExp(`(?:^|[\\s，,、：:和与])${escaped}(?=$|[\\s，,、：:和与]|你|能|要|怎|觉|喜|想|说|看)`, "u").test(text);
      }
      return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "iu").test(text);
    });
  }

  private addressesAnotherMember(text: string, history: readonly RoomMessage[]): boolean {
    const target = findExplicitAddress(normalizeAddressText(text), history);
    if (!target || publicAddress.test(target)) return false;
    return !this.config.characters.some(character => this.named(target, character));
  }

  decide(ctx: ParticipationContext): ParticipationDecision {
    if (!this.config.participation.enabled) return silence("disabled");
    if (ctx.paused) return silence("paused");
    if (ctx.stopped) return silence("stopped");
    if (ctx.busy) return silence("busy");
    if (ctx.blockedTarget) return silence("other-conversation");
    const pending = ctx.history.filter(m => m.speakerType === "user" && ctx.pendingIds.includes(m.id));
    const latest = pending.at(-1);
    if (!latest) return silence("no-input");
    if (ctx.now - ctx.observedAt < this.config.limits.ambientQuietMs) return silence("quiet");
    if (ctx.lastAttemptAt !== null && ctx.now - ctx.lastAttemptAt < this.config.limits.ambientCooldownMs) return silence("cooldown");
    if (!ctx.online.has(this.config.ingressAccountKey)) return silence("offline");
    if (!ctx.hasBudget) return silence("budget");
    const text = latest.text.trim(), normalized = normalize(text);
    if ([...normalized].length < 2 || trivialReaction.test(normalized)) return silence("trivial");
    if (pending.filter(m => normalize(m.text) === normalized).length > 1) return silence("repetition");
    const recent = ctx.history.filter(m => m.speakerType === "bot" && m.createdAt !== undefined
      && ctx.now - m.createdAt >= 0 && ctx.now - m.createdAt < FOLLOW_UP_MS);
    if (recent.length >= MAX_RECENT_BOT_TURNS) return silence("recent-bots");
    const online = this.config.characters.filter(c => ctx.online.has(c.accountKey));
    if (!online.length) return silence("offline");
    if (this.addressesAnotherMember(text, ctx.history)) {
      return silence("other-conversation");
    }
    const named = this.config.characters.filter(c => this.named(text, c));
    const rank = (characters: readonly RoomCharacter[]) => [...characters].sort((a, b) => {
      const last = (id: string) => ctx.history.findLastIndex(m => m.speakerType === "bot" && m.speakerId === id);
      return last(a.id) - last(b.id) || this.config.characters.indexOf(a) - this.config.characters.indexOf(b);
    });
    const reply = (first: RoomCharacter | undefined, reason: ParticipationReason, two = false): ParticipationDecision => {
      if (!first || !ctx.online.has(first.accountKey)) return silence("offline");
      return { shouldReply: true, reason, firstSpeaker: first.id,
        maxTurns: two && online.length === 2 && recent.length === 0 ? 2 : 1 };
    };
    if (named.length && question.test(text)) {
      return reply(rank(named.filter(c => ctx.online.has(c.accountKey)))[0], "named-question", named.length === 2 && bothViews.test(text));
    }
    if (question.test(text) && pending.length >= this.config.limits.ambientMessages
      && new Set(pending.map(m => m.speakerId)).size >= this.config.limits.ambientPeople) {
      return reply(rank(online)[0], "group-question");
    }
    if (publicAddress.test(text) && question.test(text)) return reply(rank(online)[0], "public-question", bothViews.test(text));
    const bot = recent.at(-1);
    if (bot && followUp.test(text)) {
      let target = ctx.history.find(m => m.id === bot.targetId);
      const visited = new Set<number>();
      while (target?.speakerType === "bot" && !visited.has(target.id)) {
        visited.add(target.id); target = ctx.history.find(m => m.id === target!.targetId);
      }
      if (target?.speakerType === "user" && target.speakerId === latest.speakerId) {
        return reply(this.config.characters.find(c => c.id === bot.speakerId), "follow-up");
      }
    }
    if (sharing.test(text) && [...normalized].length >= 8) return reply(rank(online)[0], "share");
    if (named.length && [...normalized].length >= 4) {
      return reply(rank(named.filter(c => ctx.online.has(c.accountKey)))[0], "named-mention", named.length === 2 && bothViews.test(text));
    }
    if (question.test(text) && [...normalized].length >= 5) {
      return reply(rank(online)[0], "open-question", bothViews.test(text));
    }
    if (/https?:\/\//i.test(text) || [...normalized].length >= 10) {
      return reply(rank(online)[0], "natural-topic");
    }
    return silence("no-signal");
  }
}
