import { PrivacyGuard } from "../privacy.js";
import { containsSensitive } from "../memory-safety.js";
import { suspectedAdult, textVariants } from "../identity-safety.js";
import { readFilePersona } from "../file-persona.js";
import { publicWebUrl } from "../web.js";
import type { ModelConfig } from "../config.js";
import type { RoomQqSettings } from "./qq-config.js";
import type { RoomCharacter, RoomPrompt } from "./types.js";
import { roomPageCandidates, ROOM_DIRECT_URL_LIMIT, ROOM_PAGE_BODY_CHARS,
  ROOM_PAGE_READ_LIMIT } from "./websearch.js";
import { parseRoomGitHubTarget, ROOM_GITHUB_EVIDENCE_CHARS, ROOM_GITHUB_TARGET_LIMIT,
  ROOM_GITHUB_TITLE_CHARS, type RoomGitHubStatus } from "./github.js";
import { ROOM_PUBLIC_TOOLS } from "./tools.js";

/** Uses pure content checks only; never constructs SharedPolicy or any PA business store. */
export function roomPublicPolicy(settings: RoomQqSettings, model: ModelConfig, configFile: string, additionalProtected: readonly string[] = []) {
  const guard = new PrivacyGuard({ secrets: [model.apiKey, model.tavilyApiKey, ...settings.accounts.map(a => a.token), ...additionalProtected]
    .filter((value): value is string => typeof value === "string" && value.length > 0),
    identityIds: [settings.room.ownerId, settings.room.groupId, ...settings.room.characters.map(c => c.selfId)],
    internalValues: [settings.dataDir, model.baseUrl, configFile, ...settings.accounts.map(a => a.personaFile)] });
  const privacy = (text: string) => textVariants(text).every(v => !containsSensitive(v)
    && guard.sanitizeForModel(v) === v && guard.redactOutbound(v) === v);
  const permitsText = (text: string) => privacy(text) && !suspectedAdult(text);
  return {
    permitsText,
    permitsPrompt: (prompt: RoomPrompt) => {
      // The code-owned core says "不输出成人内容"; content filtering must not reject that prohibition.
      // Public persona content is separately checked on every snapshot read below.
      const payload = JSON.parse(prompt.messages[0].content);
      const search = payload.search as { status?: unknown; query?: unknown; results?: unknown;
        pages?: unknown } | undefined;
      const github = payload.github as { status?: unknown; evidence?: unknown; results?: unknown } | undefined;
      const directPage = payload.directPage;
      const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
        Object.keys(value).sort().join(",") === [...keys].sort().join(",");
      const exactPublicTools = ROOM_PUBLIC_TOOLS.map(tool => JSON.stringify(tool)).sort();
      const denseOwnIndexes = (tools: readonly unknown[]): boolean => {
        for (let index = 0; index < tools.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(tools, index)) return false;
        }
        return Reflect.ownKeys(tools).every(key => key === "length"
          || (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)
            && Number(key) < tools.length));
      };
      const denseTools = Array.isArray(prompt.tools) && denseOwnIndexes(prompt.tools);
      const suppliedTools = denseTools
        ? prompt.tools.map(tool => JSON.stringify(tool)).sort() : [];
      const validPublicTools = denseTools && (prompt.tools.length === 0
        || (suppliedTools.length === exactPublicTools.length
          && suppliedTools.every((tool, index) => tool === exactPublicTools[index])));
      const canonicalPublicHttpsUrl = (value: string): boolean => {
        try {
          const normalized = publicWebUrl(value);
          return normalized.startsWith("https://") && normalized === value;
        } catch { return false; }
      };
      const validPageResult = (item: unknown): boolean => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const value = item as Record<string, unknown>;
        if (!exactKeys(value, ["status", "url"])
          || typeof value.url !== "string" || !permitsText(value.url)
          || !["ok", "failed", "timeout", "privacy_rejected", "cancelled"].includes(value.status as string)) return false;
        return canonicalPublicHttpsUrl(value.url);
      };
      const validPages = (pages: unknown): boolean => {
        if (pages === undefined) return true;
        if (!pages || typeof pages !== "object" || Array.isArray(pages)) return false;
        const value = pages as Record<string, unknown>;
        if (!exactKeys(value, ["pages", "results", "status"])
          || !["not_attempted", "ok", "partial", "failed", "timeout", "privacy_rejected", "cancelled"].includes(value.status as string)
          || !Array.isArray(value.pages) || value.pages.length > ROOM_PAGE_READ_LIMIT
          || !Array.isArray(value.results) || value.results.length > ROOM_PAGE_READ_LIMIT
          || !value.results.every(validPageResult)) return false;
        const resultList = value.results as Array<{ url: string; status: string }>;
        const resultUrls = new Set<string>();
        for (const item of resultList) resultUrls.add(item.url);
        if (resultUrls.size !== resultList.length) return false;
        if (value.status === "not_attempted") return value.pages.length === 0 && resultList.length === 0;
        const current = search!;
        if (current.status !== "ok" || resultList.length === 0) return false;
        const candidates = roomPageCandidates({
          status: current.status as "ok", query: current.query as string | null,
          results: current.results as Array<{ title: string; url: string; snippet: string;
            trust: "external-untrusted"; publishedDate?: string }>,
        });
        if (resultList.length !== candidates.length
          || !resultList.every(result => candidates.includes(result.url))) return false;
        const bodyUrls = new Set<string>();
        for (const item of value.pages) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return false;
          const page = item as Record<string, unknown>;
          if (!exactKeys(page, ["body", "trust", "url"])
            || page.trust !== "external-untrusted"
            || typeof page.url !== "string" || !permitsText(page.url)
            || typeof page.body !== "string" || !permitsText(page.body)
            || !page.body.trim() || [...page.body].length > ROOM_PAGE_BODY_CHARS) return false;
          if (!canonicalPublicHttpsUrl(page.url)) return false;
          if (!resultUrls.has(page.url)
            || !resultList.some(result => result.url === page.url && result.status === "ok")) return false;
          bodyUrls.add(page.url);
        }
        if (bodyUrls.size !== value.pages.length) return false;
        const okCount = resultList.filter(result => result.status === "ok").length;
        if (value.status === "ok") {
          return resultList.length > 0 && okCount === resultList.length && value.pages.length === resultList.length;
        }
        if (value.status === "partial") {
          return resultList.length >= 2 && okCount > 0 && okCount < resultList.length
            && value.pages.length === okCount;
        }
        if (value.status === "failed") return value.pages.length === 0 && okCount === 0;
        if (value.status === "timeout") {
          return value.pages.length === 0 && resultList.every(result => result.status === "timeout");
        }
        if (value.status === "privacy_rejected") {
          return value.pages.length === 0 && resultList.every(result => result.status === "privacy_rejected");
        }
        return value.pages.length === 0 && resultList.every(result => result.status === "cancelled");
      };
      const validDirectPage = (value: unknown): boolean => {
        if (value === undefined) return true;
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const direct = value as Record<string, unknown>;
        if (!exactKeys(direct, ["pages", "results", "status"])
          || typeof direct.status !== "string"
          || !["not_attempted", "ok", "failed", "timeout", "privacy_rejected", "cancelled"]
            .includes(direct.status)
          || !Array.isArray(direct.pages) || direct.pages.length > ROOM_DIRECT_URL_LIMIT
          || !Array.isArray(direct.results) || direct.results.length > ROOM_DIRECT_URL_LIMIT
          || !direct.results.every(validPageResult)) return false;
        const resultList = direct.results as Array<{ url: string; status: string }>;
        if (new Set(resultList.map(result => result.url)).size !== resultList.length) return false;
        if (!resultList.every(result => canonicalPublicHttpsUrl(result.url))) return false;
        const pageUrls = new Set<string>();
        for (const item of direct.pages) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return false;
          const page = item as Record<string, unknown>;
          if (!exactKeys(page, ["body", "trust", "url"])
            || page.trust !== "external-untrusted"
            || typeof page.url !== "string" || !permitsText(page.url)
            || typeof page.body !== "string" || !permitsText(page.body)
            || !page.body.trim() || [...page.body].length > ROOM_PAGE_BODY_CHARS) return false;
          if (!canonicalPublicHttpsUrl(page.url)) return false;
          if (!resultList.some(result => result.url === page.url && result.status === "ok")) return false;
          pageUrls.add(page.url);
        }
        if (pageUrls.size !== direct.pages.length) return false;
        if (direct.status === "not_attempted") {
          return direct.pages.length === 0 && resultList.length === 0;
        }
        const resultStatuses = resultList.map(result => result.status);
        if (direct.status === "ok") {
          return resultList.length === 1 && resultStatuses[0] === "ok" && direct.pages.length === 1
            && (direct.pages[0] as Record<string, unknown>).url === resultList[0]!.url;
        }
        if (direct.status === "failed") {
          return direct.pages.length === 0
            && (resultList.length === 0 || resultStatuses.every(status => status === "failed"));
        }
        if (direct.status === "timeout") {
          return direct.pages.length === 0
            && (resultList.length === 0 || resultStatuses.every(status => status === "timeout"));
        }
        if (direct.status === "privacy_rejected") {
          return direct.pages.length === 0
            && (resultList.length === 0 || resultStatuses.every(status => status === "privacy_rejected"));
        }
        return direct.pages.length === 0
          && (resultList.length === 0 || resultStatuses.every(status => status === "cancelled"));
      };
      const validSearch = search === undefined || (
        exactKeys(search as Record<string, unknown>, Object.prototype.hasOwnProperty.call(search, "pages")
          ? ["pages", "query", "results", "status"] : ["query", "results", "status"])
        && typeof search.status === "string"
        && ["ok", "empty", "unavailable", "failed", "timeout", "privacy_rejected", "cancelled"].includes(search.status)
        && (search.query === null || (typeof search.query === "string" && permitsText(search.query)))
        && Array.isArray(search.results)
        && search.results.every((item: unknown) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return false;
          const value = item as Record<string, unknown>;
          return exactKeys(value, ["publishedDate", "snippet", "title", "trust", "url"].filter(key => key !== "publishedDate"
            || Object.prototype.hasOwnProperty.call(value, key)))
            && value.trust === "external-untrusted"
            && typeof value.title === "string" && permitsText(value.title)
            && typeof value.url === "string" && permitsText(value.url)
            && typeof value.snippet === "string" && permitsText(value.snippet)
            && (value.publishedDate === undefined
              || (typeof value.publishedDate === "string" && permitsText(value.publishedDate)));
        })
        && validPages(search.pages)
      );
      const validGitHub = (value: unknown): boolean => {
        if (value === undefined) return true;
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const context = value as Record<string, unknown>;
        if (!exactKeys(context, ["evidence", "results", "status"])
          || typeof context.status !== "string"
          || !["ok", "partial", "not_found", "forbidden", "rate_limited", "timeout",
            "unsupported", "invalid_response", "http_error", "privacy_rejected",
            "cancelled", "failed"].includes(context.status)
          || !Array.isArray(context.evidence) || context.evidence.length > ROOM_GITHUB_TARGET_LIMIT
          || !Array.isArray(context.results) || context.results.length > ROOM_GITHUB_TARGET_LIMIT) return false;
        const resultUrls = new Set<string>();
        for (const item of context.results) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return false;
          const result = item as Record<string, unknown>;
          if (!exactKeys(result, ["status", "url"])
            || typeof result.url !== "string" || !permitsText(result.url)
            || typeof result.status !== "string"
            || !["ok", "partial", "not_found", "forbidden", "rate_limited", "timeout",
              "unsupported", "invalid_response", "http_error", "privacy_rejected",
              "cancelled", "failed"].includes(result.status)) return false;
          const parsed = parseRoomGitHubTarget(result.url);
          if (!parsed || parsed.htmlUrl !== result.url) return false;
          try { publicWebUrl(result.url); } catch { return false; }
          if (resultUrls.has(result.url)) return false;
          resultUrls.add(result.url);
        }
        const evidenceUrls = new Set<string>();
        for (const item of context.evidence) {
          if (!item || typeof item !== "object" || Array.isArray(item)) return false;
          const evidence = item as Record<string, unknown>;
          if (!exactKeys(evidence, ["kind", "text", "title", "truncated", "trust", "url"])
            || evidence.trust !== "external-untrusted"
            || typeof evidence.url !== "string" || !permitsText(evidence.url)
            || typeof evidence.title !== "string" || !permitsText(evidence.title)
            || !evidence.title.trim() || [...evidence.title].length > ROOM_GITHUB_TITLE_CHARS
            || typeof evidence.text !== "string" || !permitsText(evidence.text)
            || !evidence.text.trim() || [...evidence.text].length > ROOM_GITHUB_EVIDENCE_CHARS
            || typeof evidence.truncated !== "boolean"
            || typeof evidence.kind !== "string"
            || !["repository", "blob", "tree", "issue", "pull", "commit", "commits"].includes(evidence.kind)) return false;
          const parsed = parseRoomGitHubTarget(evidence.url);
          if (!parsed || parsed.kind === "unsupported" || parsed.htmlUrl !== evidence.url
            || parsed.kind !== evidence.kind) return false;
          try { publicWebUrl(evidence.url); } catch { return false; }
          if (!resultUrls.has(evidence.url)
            || !context.results.some(result => (result as Record<string, unknown>).url === evidence.url
              && ["ok", "partial"].includes(String((result as Record<string, unknown>).status)))) return false;
          if (evidenceUrls.has(evidence.url)) return false;
          evidenceUrls.add(evidence.url);
        }
        const statuses = context.results.map(result => (result as Record<string, unknown>).status as RoomGitHubStatus);
        if (context.status === "ok") {
          return context.results.length > 0 && statuses.every(status => status === "ok")
            && context.evidence.length === context.results.length;
        }
        if (context.status === "partial") {
          const resultList = context.results as Array<Record<string, unknown>>;
          return context.evidence.length > 0
            && statuses.some(status => status !== "ok")
            && context.evidence.every(evidence => resultList.some(result =>
              result.url === (evidence as Record<string, unknown>).url
              && ["ok", "partial"].includes(String(result.status))));
        }
        if (context.status === "failed") {
          return context.evidence.length === 0
            && !statuses.includes("ok") && !statuses.includes("partial");
        }
        if (context.status === "cancelled") {
          return context.evidence.length === 0 && statuses.every(status => status === "cancelled");
        }
        return context.evidence.length === 0 && statuses.every(status => status === context.status);
      };
      return validPublicTools && privacy(prompt.systemPrompt) && Array.isArray(payload.visibleHistory)
        && validSearch
        && validGitHub(github)
        && validDirectPage(directPage)
        && payload.visibleHistory.every((m: { text: unknown }) => typeof m.text === "string" && permitsText(m.text))
        && (payload.voiceTranslation === undefined || (typeof payload.voiceTranslation?.sourceText === "string"
          && permitsText(payload.voiceTranslation.sourceText)));
    },
    persona: (c: RoomCharacter) => {
      const account = settings.accounts.find(a => a.accountKey === c.accountKey);
      if (!account) throw new Error("room-public-persona-missing");
      const snapshot = readFilePersona(account.personaFile, c.id);
      if (!permitsText(snapshot.content) || !permitsText(c.name)) throw new Error("room-public-persona-unsafe");
      return snapshot.content;
    },
  };
}
