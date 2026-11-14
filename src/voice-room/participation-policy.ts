import type { CheckedRoomConfig } from "./config.js";
import type { RoomCharacter, RoomMessage } from "./types.js";

export type ParticipationReason = "disabled" | "paused" | "stopped" | "busy" | "no-input" | "quiet"
  | "cooldown" | "offline" | "budget" | "other-conversation" | "trivial" | "repetition"
  | "recent-bots" | "no-signal" | "named-question" | "public-question" | "follow-up" | "share" | "group-question";
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
const sharing = /(?:今天|刚刚|刚才|终于|最近).{0,40}(?:完成|搞定|做完|跑通|拿到|学会|通过|发现|做了|去了|买了|吃了|看了|听了)/;
const normalize = (s: string) => s.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
const silence = (reason: ParticipationReason): ParticipationDecision => ({ shouldReply: false, reason, maxTurns: 0 });

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
    if ([...normalized].length < 2 || /^(嗯+|哦+|啊+|好+|哈+|呵+|收到|谢谢|好的|行吧|ok|yes|no)$/i.test(normalized)) return silence("trivial");
    if (pending.filter(m => normalize(m.text) === normalized).length > 1) return silence("repetition");
    const recent = ctx.history.filter(m => m.speakerType === "bot" && m.createdAt !== undefined
      && ctx.now - m.createdAt >= 0 && ctx.now - m.createdAt < FOLLOW_UP_MS);
    if (recent.length >= MAX_RECENT_BOT_TURNS) return silence("recent-bots");
    const online = this.config.characters.filter(c => ctx.online.has(c.accountKey));
    if (!online.length) return silence("offline");
    const address = /^([^\s，,:：]{1,12})[，,:：]\s*你(?!们)/u.exec(text)?.[1];
    if (address && !publicAddress.test(address) && !this.config.characters.some(c => this.named(address, c))) {
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
    if (question.test(text) && [...normalized].length >= 6 && pending.length >= this.config.limits.ambientMessages
      && new Set(pending.map(m => m.speakerId)).size >= this.config.limits.ambientPeople) {
      return reply(rank(online)[0], "group-question");
    }
    return silence("no-signal");
  }
}
