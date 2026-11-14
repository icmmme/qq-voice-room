import { PrivacyGuard } from "./privacy.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { containsSensitive } from "./memory-safety.js";
import { PaStore } from "./storage.js";

/** Finite conservative boundary, not an adult authorization/classification system. */
export function textVariants(text: string): string[] {
  let value = text.normalize("NFKC").replace(/[\p{Cf}]/gu, "");
  value = value.replace(/\\u([0-9a-f]{4})/gi, (_match,hex:string)=>String.fromCharCode(parseInt(hex,16)));
  const variants = new Set([value]);
  for (let i=0;i<3;i++) {
    try { const next = decodeURIComponent(value); if(next===value) break; value=next; variants.add(value); }
    catch { break; }
  }
  for (const candidate of [...variants]) {
    for (const token of candidate.match(/[A-Za-z0-9+/_-]{8,}={0,2}|[0-9a-fA-F]{8,}/g) ?? []) {
      for (const encoding of ["base64url","hex"] as const) {
        const decoded = Buffer.from(token,encoding).toString("utf8");
        if (decoded && !decoded.includes("\uFFFD")) {
          variants.add(decoded);
          try { variants.add(decodeURIComponent(decoded)); } catch { /* Keep the undecoded view. */ }
        }
      }
    }
  }
  return [...variants].map(item=>item.normalize("NFKC").replace(/[\p{Cf}]/gu,"")
    .replace(/\\u([0-9a-f]{4})/gi,(_match,hex:string)=>String.fromCharCode(parseInt(hex,16))));
}
export function suspectedAdult(text: string): boolean {
  return textVariants(text).some(value => /色情|性爱|做爱|性交|口交|肛交|自慰|手淫|裸照|裸体|性器|阴茎|阴道|乳交|调教|淫荡|发情|成人内容|成人模式|\b(?:nsfw|porn|hentai|erotic|blowjob|nudes?|sexting)\b/i.test(value));
}
export class SharedWriteBlocked extends Error {
  constructor() { super("此内容未通过共享过滤，未写入身份共享范围。"); this.name="SharedWriteBlocked"; }
}
export class SharedPolicy {
  turnAllowed = true;
  private readonly contentOnly = new AsyncLocalStorage<boolean>();
  constructor(private readonly guard: PrivacyGuard) {}
  /** Jobs were admitted when enqueued. Later turns must not change their write permission;
   * candidate content still passes the same filters, across awaits and retries.
   */
  withContentOnlyChecks<T>(operation: () => Promise<T>): Promise<T> {
    return this.contentOnly.run(true,operation);
  }
  allows(input: unknown): boolean {
    try {
      if (input === null || input === undefined || typeof input === "number" || typeof input === "boolean") return true;
      if (typeof input === "string") return textVariants(input).every(text => {
        this.guard.assertWebRequest("shared",text);
        return !containsSensitive(text) && !suspectedAdult(text);
      });
      if (Array.isArray(input)) return input.every(item=>this.allows(item));
      if (typeof input === "object") return Object.entries(input).every(([key,value]) =>
        !/adult|nsfw|sexual|consent|sensitive/i.test(key) && this.allows(value));
      return false;
    } catch { return false; }
  }
  assert(input: unknown): void {
    if ((!this.contentOnly.getStore() && !this.turnAllowed) || !this.allows(input)) throw new SharedWriteBlocked();
  }
}

/** One write boundary covers tools, automatic extraction and relationship persistence.
 * Unbound stores keep all existing behavior. No rejected raw text is copied elsewhere.
 */
export class SharedPaStore extends PaStore {
  constructor(filename: string, private readonly policy: SharedPolicy, timezone?: string, readOnly = false) {
    super(filename,undefined,timezone,readOnly);
  }
  override saveNote(...args: Parameters<PaStore["saveNote"]>) { this.policy.assert(args); return super.saveNote(...args); }
  override updateNote(...args: Parameters<PaStore["updateNote"]>) { this.policy.assert(args); return super.updateNote(...args); }
  override addTask(...args: Parameters<PaStore["addTask"]>) { this.policy.assert(args); return super.addTask(...args); }
  override saveMemory(...args: Parameters<PaStore["saveMemory"]>) { this.policy.assert(args); return super.saveMemory(...args); }
  override updateMemory(...args: Parameters<PaStore["updateMemory"]>) { this.policy.assert(args); return super.updateMemory(...args); }
  override enqueueMemoryExtraction(...args: Parameters<PaStore["enqueueMemoryExtraction"]>) { this.policy.assert(args); return super.enqueueMemoryExtraction(...args); }
  override applyEventBatch(...args: Parameters<PaStore["applyEventBatch"]>) { this.policy.assert(args); return super.applyEventBatch(...args); }
  override applyIntimacySignal(...args: Parameters<PaStore["applyIntimacySignal"]>) { this.policy.assert(args); return super.applyIntimacySignal(...args); }
  override recordRelationshipEvent(...args: Parameters<PaStore["recordRelationshipEvent"]>) { this.policy.assert(args); return super.recordRelationshipEvent(...args); }
  override recordRelationshipEvidence(...args: Parameters<PaStore["recordRelationshipEvidence"]>) { this.policy.assert(args); return super.recordRelationshipEvidence(...args); }
  override recordToolAudit(...args: Parameters<PaStore["recordToolAudit"]>) {
    // Even a rejected web URL may contain sensitive/adult text in its host or parameter keys.
    // Shared audits keep app-owned status/count metadata only, including on blocked turns.
    const [name,, ,status,duration,summary,errorCode]=args;
    const count=summary && typeof summary==="object" ? Object.keys(summary).length : 0;
    super.recordToolAudit(/^[a-z_]{1,100}$/.test(name) ? name : "tool", "bound-private","owner",status,duration,
      {parameterCount:count},errorCode && /^[a-z-]{1,40}$/.test(errorCode) ? errorCode : "");
  }
}
