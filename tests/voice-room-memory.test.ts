import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { estimateTokens } from "../src/prompting/token-estimate.js";
import {
  formatMemoryBlock,
  formatMemorySummary,
  isValidSenderKey,
  parseMemoryCommand,
  ROOM_MEMORY_FILE,
  ROOM_MEMORY_SCHEMA_VERSION,
  RoomMemoryStore,
  selectRelevantMemories,
} from "../src/voice-room/memory.js";

function makeTempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "qq-voice-room-memory-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("RoomMemoryStore CRUD, scoped isolation, pinning, and reload persistence", t => {
  const dir = makeTempDir(t);
  let clock = 1_700_000_000_000;
  const store = new RoomMemoryStore(dir, {
    now: () => clock,
    defaultTtlMs: 60_000,
  });

  assert.equal(store.filePath, join(dir, ROOM_MEMORY_FILE));
  assert.deepEqual(store.list(), []);

  const roomRes = store.remember({
    scope: "room",
    content: "每周六晚上群里一起打麻将",
    tags: ["活动", "麻将"],
  });
  assert.equal(roomRes.ok, true);
  if (!roomRes.ok) throw new Error("expected ok");
  assert.equal(roomRes.action, "created");
  assert.equal(roomRes.entry.scope, "room");
  assert.equal(roomRes.entry.pinned, false);
  assert.equal(roomRes.entry.expiresAt, clock + 60_000);

  clock += 1_000;
  const memberRes = store.remember({
    scope: "member",
    senderKey: "member-a1b2c3d4e5f60718",
    content: "喜欢喝乌龙茶，不要太甜",
    tags: ["饮品"],
    pinned: true,
  });
  assert.equal(memberRes.ok, true);
  if (!memberRes.ok) throw new Error("expected ok");
  assert.equal(memberRes.entry.scope, "member");
  assert.equal(memberRes.entry.senderKey, "member-a1b2c3d4e5f60718");
  assert.equal(memberRes.entry.pinned, true);
  assert.equal(memberRes.entry.expiresAt, null);

  // Verify JSON sidecar file exists and no temp files remain.
  assert.equal(existsSync(store.filePath), true);
  assert.deepEqual(readdirSync(dir), [ROOM_MEMORY_FILE]);
  const raw = JSON.parse(readFileSync(store.filePath, "utf8")) as { version: number; entries: unknown[] };
  assert.equal(raw.version, ROOM_MEMORY_SCHEMA_VERSION);
  assert.equal(raw.entries.length, 2);

  // Reload into a fresh store instance.
  const reloaded = new RoomMemoryStore(dir, { now: () => clock });
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.get(roomRes.entry.id)?.content, "每周六晚上群里一起打麻将");
  assert.equal(reloaded.list({ scope: "member", senderKey: "member-a1b2c3d4e5f60718" }).length, 1);
  assert.equal(reloaded.list({ scope: "member", senderKey: "member-other99999999" }).length, 0);

  // Pinning / unpinning updates expiry cleanly.
  clock += 500;
  const unpinned = reloaded.pin(memberRes.entry.id, false, clock);
  assert.ok(unpinned);
  assert.equal(unpinned.pinned, false);
  assert.notEqual(unpinned.expiresAt, null);

  const repinned = reloaded.pin(memberRes.entry.id, true, clock + 100);
  assert.ok(repinned);
  assert.equal(repinned.pinned, true);
  assert.equal(repinned.expiresAt, null);

  // Forget by ID and by keyword.
  const forgetById = reloaded.forget(roomRes.entry.id);
  assert.equal(forgetById.removed.length, 1);
  assert.equal(forgetById.remaining, 1);

  const forgetByKeyword = reloaded.forget("乌龙茶", { scope: "member" });
  assert.equal(forgetByKeyword.removed.length, 1);
  assert.equal(forgetByKeyword.remaining, 0);
});

test("RoomMemoryStore deduplicates/upserts, expires TTL entries, and enforces maxEntries cap", t => {
  const dir = makeTempDir(t);
  let clock = 1_000_000;
  const store = new RoomMemoryStore(dir, {
    now: () => clock,
    maxEntries: 3,
    defaultTtlMs: 10_000,
  });

  // Deduplication / upsert: same canonical content updates existing entry instead of duplicating.
  const first = store.remember({
    scope: "room",
    content: "  Project   Alpha  ",
    tags: ["project"],
  });
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error("expected ok");

  clock += 100;
  const dup = store.remember({
    scope: "room",
    content: "project alpha",
    tags: ["project", "active"],
    pinned: true,
  });
  assert.equal(dup.ok, true);
  if (!dup.ok) throw new Error("expected ok");
  assert.equal(dup.action, "updated");
  assert.equal(dup.entry.id, first.entry.id);
  assert.equal(dup.entry.createdAt, 1_000_000);
  assert.equal(dup.entry.updatedAt, 1_000_100);
  assert.equal(dup.entry.pinned, true);
  assert.equal(dup.entry.expiresAt, null);
  assert.equal(store.list().length, 1);

  // Fill up to maxEntries = 3 and add a 4th; oldest non-pinned entry should be evicted, pinned kept.
  clock += 100;
  store.remember({ scope: "room", content: "临时梗一", pinned: false });
  clock += 100;
  store.remember({ scope: "room", content: "临时梗二", pinned: false });
  clock += 100;
  store.remember({ scope: "room", content: "临时梗三", pinned: false });

  const listed = store.list();
  assert.equal(listed.length, 3);
  assert.ok(listed.some(item => item.id === first.entry.id), "pinned entry should survive eviction");
  assert.ok(!listed.some(item => item.content === "临时梗一"), "oldest non-pinned entry should be evicted");

  // TTL expiry drops non-pinned entries while keeping pinned entries across reload.
  clock += 20_000;
  assert.equal(store.pruneExpired(clock), 2);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]?.id, first.entry.id);

  const reloaded = new RoomMemoryStore(dir, { now: () => clock });
  assert.equal(reloaded.list().length, 1);
});

test("RoomMemoryStore rejects raw QQ IDs, invalid scopes, and corrupt sidecar files", t => {
  const dir = makeTempDir(t);
  const store = new RoomMemoryStore(dir);

  assert.equal(isValidSenderKey("member-0123456789abcdef"), true);
  assert.equal(isValidSenderKey("10001"), false);
  assert.equal(isValidSenderKey("qq12345678"), false);
  assert.equal(isValidSenderKey("qq-12345678"), false);
  assert.equal(isValidSenderKey(""), false);

  for (const badKey of ["10001", "123456789", "qq10001", "qq_999999", "  "]) {
    const res = store.remember({
      scope: "member",
      senderKey: badKey,
      content: "偏好简短回复",
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "invalid-sender-key");
  }

  const roomWithSender = store.remember({
    scope: "room",
    senderKey: "member-0123456789abcdef",
    content: "不应接受 senderKey",
  });
  assert.equal(roomWithSender.ok, false);
  if (!roomWithSender.ok) assert.equal(roomWithSender.reason, "invalid-input");

  writeFileSync(store.filePath, "{not-valid-json", "utf8");
  assert.throws(() => new RoomMemoryStore(dir), /room-memory-corrupt/);
});

test("Privacy gating rejects secrets, PII, private paths, and hook failures fail-closed on save and inject", t => {
  const dir = makeTempDir(t);
  const blockedSamples = [
    "我的 key 是 sk-1234567890abcdef1234",
    "token: ghp_1234567890abcdefghij123456",
    "Authorization: Bearer abcdefghijklmnop",
    "联系手机号 13812345678",
    "邮箱是 alice@example.com",
    "身份证 110101199001011234",
    "目录在 D:\\demo\\secret\\notes.txt",
    "配置文件 /Users/alice/.env",
    "读取 .env.local 获取密码",
    "包含空字节\0的文本",
  ];

  const throwingStore = new RoomMemoryStore(dir, {
    permitsText: text => {
      if (text.includes("boom")) throw new Error("policy-failure");
      return !text.includes("禁止词");
    },
  });

  for (const sample of blockedSamples) {
    const res = throwingStore.remember({ scope: "room", content: sample });
    assert.equal(res.ok, false, `expected rejection for: ${sample}`);
  }

  const customBlocked = throwingStore.remember({ scope: "room", content: "这里有禁止词" });
  assert.equal(customBlocked.ok, false);
  if (!customBlocked.ok) assert.equal(customBlocked.reason, "privacy-rejected");

  const thrownBlocked = throwingStore.remember({ scope: "room", content: "trigger boom check" });
  assert.equal(thrownBlocked.ok, false);
  if (!thrownBlocked.ok) assert.equal(thrownBlocked.reason, "privacy-rejected");

  assert.equal(throwingStore.list().length, 0);

  // Even if an entry was saved before a stricter permitsText policy or edited externally on disk,
  // selectRelevantMemories and formatMemoryBlock must filter it out fail-closed.
  const saved = throwingStore.remember({ scope: "room", content: "大家喜欢讨论 TypeScript" });
  assert.equal(saved.ok, true);

  const strictPermits = (text: string) => !text.includes("TypeScript");
  const selected = throwingStore.selectRelevantMemories({
    queryText: "TypeScript",
    permitsText: strictPermits,
  });
  assert.deepEqual(selected, []);

  assert.equal(
    formatMemoryBlock(throwingStore.list(), { permitsText: strictPermits }),
    "",
  );
  assert.equal(
    formatMemoryBlock(throwingStore.list(), {
      permitsText: () => { throw new Error("fail-closed"); },
    }),
    "",
  );
});

test("selectRelevantMemories ranks by keyword + recency, isolates member scope, and enforces token budget", () => {
  const now = 2_000_000_000;
  const entries = [
    {
      id: "mem-00000001",
      scope: "room" as const,
      content: "群里周六经常一起玩乌龙茶品鉴会",
      tags: ["周六"],
      pinned: false,
      createdAt: now - 10 * 86_400_000,
      updatedAt: now - 10 * 86_400_000,
      expiresAt: null,
    },
    {
      id: "mem-00000002",
      scope: "room" as const,
      content: "昨天聊了 Rust 和 Node24 编译优化",
      pinned: true,
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
      expiresAt: null,
    },
    {
      id: "mem-00000003",
      scope: "member" as const,
      senderKey: "member-alice000000001",
      content: "偏爱乌龙茶，晚上不喝咖啡",
      pinned: false,
      createdAt: now - 5_000,
      updatedAt: now - 5_000,
      expiresAt: null,
    },
    {
      id: "mem-00000004",
      scope: "member" as const,
      senderKey: "member-bob00000000002",
      content: "Bob 自己记录的乌龙茶私人口味",
      pinned: true,
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
      expiresAt: null,
    },
    {
      id: "mem-00000005",
      scope: "room" as const,
      content: "已过期的乌龙茶记录",
      pinned: false,
      createdAt: now - 50_000,
      updatedAt: now - 50_000,
      expiresAt: now - 1,
    },
  ];

  const selected = selectRelevantMemories({
    entries,
    queryText: "今晚要不要泡乌龙茶",
    senderKey: "member-alice000000001",
    maxItems: 4,
    maxTokens: 200,
    now,
  });

  // Never leaks Bob's member memory or expired entries.
  assert.ok(!selected.some(e => e.id === "mem-00000004"));
  assert.ok(!selected.some(e => e.id === "mem-00000005"));
  // Top results should rank both tea memories ahead of unrelated Rust note, with recent member memory first.
  assert.equal(selected[0]?.id, "mem-00000003");
  assert.equal(selected[1]?.id, "mem-00000001");

  const block = formatMemoryBlock(selected);
  assert.ok(block.startsWith("【长期记忆（背景参考）】\n"));
  assert.ok(block.includes("- [成员] 偏爱乌龙茶，晚上不喝咖啡"));
  assert.ok(block.includes("- [群] 群里周六经常一起玩乌龙茶品鉴会"));
  assert.ok(estimateTokens(block) <= 200);

  // Strict maxTokens cap skips entries that exceed remaining token budget.
  const tightBudget = 60;
  const tightSelected = selectRelevantMemories({
    entries,
    queryText: "乌龙茶",
    senderKey: "member-alice000000001",
    maxItems: 5,
    maxTokens: tightBudget,
    now,
  });
  const tightBlock = formatMemoryBlock(tightSelected);
  assert.ok(tightSelected.length >= 1);
  assert.ok(estimateTokens(tightBlock) <= tightBudget);

  // Zero / non-positive budget returns empty cleanly.
  assert.deepEqual(
    selectRelevantMemories({ entries, queryText: "乌龙茶", maxItems: 3, maxTokens: 0, now }),
    [],
  );
  assert.deepEqual(
    selectRelevantMemories({ entries, queryText: "乌龙茶", maxItems: 0, maxTokens: 200, now }),
    [],
  );
});

test("parseMemoryCommand and formatMemorySummary handle owner commands and non-memory commands", t => {
  const dir = makeTempDir(t);
  const store = new RoomMemoryStore(dir);

  assert.deepEqual(parseMemoryCommand("/room remember   群吉祥物是一只橘猫  "), {
    kind: "remember",
    scope: "room",
    fact: "群吉祥物是一只橘猫",
  });
  assert.deepEqual(parseMemoryCommand("/room forget 橘猫"), {
    kind: "forget",
    query: "橘猫",
  });
  assert.deepEqual(parseMemoryCommand("/room forget mem-12ab34cd"), {
    kind: "forget",
    query: "mem-12ab34cd",
  });
  assert.deepEqual(parseMemoryCommand("/room memory"), {
    kind: "list",
  });

  // Invalid memory subcommands.
  assert.deepEqual(parseMemoryCommand("/room remember   "), {
    kind: "invalid",
    action: "remember",
    reason: "missing-fact",
  });
  assert.deepEqual(parseMemoryCommand("/room forget"), {
    kind: "invalid",
    action: "forget",
    reason: "missing-query",
  });
  assert.deepEqual(parseMemoryCommand("/room memory extra"), {
    kind: "invalid",
    action: "list",
    reason: "unexpected-args",
  });

  // Privacy-rejected remember command (both baseline and custom permitsText).
  assert.deepEqual(parseMemoryCommand("/room remember 我的手机 13900001111"), {
    kind: "rejected",
    action: "remember",
    reason: "privacy-rejected",
  });
  assert.deepEqual(
    parseMemoryCommand("/room remember 禁止写入的内容", {
      permitsText: text => !text.includes("禁止写入"),
    }),
    {
      kind: "rejected",
      action: "remember",
      reason: "privacy-rejected",
    },
  );

  // Non-memory /room commands and ordinary chat return null.
  assert.equal(parseMemoryCommand("/room status"), null);
  assert.equal(parseMemoryCommand("/room stop"), null);
  assert.equal(parseMemoryCommand("/room mode ambient"), null);
  assert.equal(parseMemoryCommand("今天天气不错"), null);

  // End-to-end summary formatting.
  assert.equal(store.summarize(), "当前暂无长期记忆。");
  const cmd = parseMemoryCommand("/room remember 群吉祥物是一只橘猫");
  assert.equal(cmd?.kind, "remember");
  if (cmd?.kind === "remember") {
    store.remember({ scope: cmd.scope, content: cmd.fact, pinned: true });
  }
  const summary = store.summarize();
  assert.ok(summary.includes("长期记忆共 1 条："));
  assert.ok(summary.includes("(群·置顶) 群吉祥物是一只橘猫"));
  assert.equal(formatMemorySummary(store.list(), { permitsText: () => false }), "当前暂无长期记忆。");
});
