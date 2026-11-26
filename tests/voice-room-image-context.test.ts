import assert from "node:assert/strict";
import test from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { checkRoomConfig } from "../src/voice-room/config.js";
import {
  RECENT_IMAGE_MAX_ENTRIES,
  RECENT_IMAGE_TTL_MS,
  RecentImageCache,
  displayTextWithImagePlaceholder,
  formatImagePlaceholder,
  isImageFollowUpText,
} from "../src/voice-room/image-context.js";
import { parseRoomQqMessage } from "../src/voice-room/qq-message.js";
import type { RoomConfig } from "../src/voice-room/types.js";

function sampleImage(tag: string, mimeType = "image/png"): ImageContent {
  return {
    type: "image",
    mimeType,
    data: Buffer.from(`img-${tag}`).toString("base64"),
  };
}

function minimalRoomConfig(): RoomConfig {
  return {
    roomId: "image-ctx-room",
    groupId: "10000",
    ownerId: "10001",
    ingressAccountKey: "account-a",
    deliveryMode: "text",
    characters: [
      { id: "character-a", accountKey: "account-a", selfId: "10002", name: "Character A", voiceKey: "voice-a" },
      { id: "character-b", accountKey: "account-b", selfId: "10003", name: "Character B", voiceKey: "voice-b" },
    ],
  };
}

test("formatImagePlaceholder and displayTextWithImagePlaceholder format placeholders without breaking parseRoomQqMessage", () => {
  assert.equal(formatImagePlaceholder(0), "");
  assert.equal(formatImagePlaceholder(-2), "");
  assert.equal(formatImagePlaceholder(Number.NaN), "");
  assert.equal(formatImagePlaceholder(1), "[图片]");
  assert.equal(formatImagePlaceholder(2), "[图片×2]");
  assert.equal(formatImagePlaceholder(4), "[图片×4]");

  assert.equal(displayTextWithImagePlaceholder("", 0), "");
  assert.equal(displayTextWithImagePlaceholder("  hello  ", 0), "hello");
  assert.equal(displayTextWithImagePlaceholder("", 1), "[图片]");
  assert.equal(displayTextWithImagePlaceholder("   ", 3), "[图片×3]");
  assert.equal(displayTextWithImagePlaceholder(" 看一下这张图 ", 1), "[图片] 看一下这张图");
  assert.equal(displayTextWithImagePlaceholder("对比两张", 2), "[图片×2] 对比两张");
  // Idempotent if already formatted
  assert.equal(displayTextWithImagePlaceholder("[图片]", 1), "[图片]");
  assert.equal(displayTextWithImagePlaceholder("[图片×2] 对比两张", 2), "[图片×2] 对比两张");

  // Confirm raw parseRoomQqMessage still produces text === "" on pure-image + @bot events
  const checked = checkRoomConfig(minimalRoomConfig());
  const parsed = parseRoomQqMessage({
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    group_id: 10000,
    user_id: 10001,
    self_id: 10002,
    message_id: 77001,
    message: [
      { type: "at", data: { qq: "10002" } },
      { type: "image", data: { url: "https://cdn.example.com/pure.png" } },
    ],
  }, "account-a", checked);
  assert.ok(parsed);
  assert.equal(parsed.text, "");
  assert.deepEqual(parsed.images, ["https://cdn.example.com/pure.png"]);
  assert.equal(displayTextWithImagePlaceholder(parsed.text, parsed.images?.length ?? 0), "[图片]");
});

test("RecentImageCache remembers entries, deduplicates by platformMessageId, and bounds at max 8 entries", () => {
  assert.equal(RECENT_IMAGE_MAX_ENTRIES, 8);
  assert.equal(RECENT_IMAGE_TTL_MS, 10 * 60 * 1000);

  const cache = new RecentImageCache();
  assert.equal(cache.remember({
    platformMessageId: "empty-1",
    createdAt: 1000,
    images: [],
  }), null);
  assert.equal(cache.size, 0);

  for (let i = 1; i <= 10; i++) {
    const stored = cache.remember({
      messageRowId: i,
      platformMessageId: `msg-${i}`,
      createdAt: i * 1000,
      count: i % 2 === 0 ? 2 : 1,
      images: i % 2 === 0 ? [sampleImage(`${i}a`), sampleImage(`${i}b`)] : [sampleImage(`${i}`)],
      caption: `caption-${i}`,
    });
    assert.ok(stored);
    assert.equal(Object.isFrozen(stored), true);
    assert.equal(Object.isFrozen(stored.images), true);
  }

  assert.equal(cache.size, 8);
  const listed = cache.list(10_000);
  assert.deepEqual(listed.map(item => item.platformMessageId), [
    "msg-3", "msg-4", "msg-5", "msg-6", "msg-7", "msg-8", "msg-9", "msg-10",
  ]);
  assert.equal(cache.get("msg-1", 10_000), null);
  assert.equal(cache.get("msg-2", 10_000), null);
  assert.equal(cache.get("msg-3", 10_000)?.messageRowId, 3);

  // Updating an existing platformMessageId refreshes its entry without growing beyond 8
  cache.remember({
    messageRowId: 44,
    platformMessageId: "msg-4",
    createdAt: 11_000,
    images: [sampleImage("4-updated")],
    caption: "updated",
  });
  assert.equal(cache.size, 8);
  assert.deepEqual(cache.list(11_000).map(item => item.platformMessageId), [
    "msg-3", "msg-5", "msg-6", "msg-7", "msg-8", "msg-9", "msg-10", "msg-4",
  ]);
  assert.equal(cache.get("msg-4", 11_000)?.caption, "updated");
});

test("RecentImageCache prunes entries after 10-minute TTL on remember, get, prune, and resolveForFollowUp", () => {
  const cache = new RecentImageCache();
  const t0 = 1_000_000;
  cache.remember({
    messageRowId: 10,
    platformMessageId: "img-old",
    createdAt: t0,
    images: [sampleImage("old")],
  });
  cache.remember({
    messageRowId: 11,
    platformMessageId: "img-mid",
    createdAt: t0 + 300_000,
    images: [sampleImage("mid")],
  });

  // Just before 10m expiry for img-old
  assert.ok(cache.get("img-old", t0 + RECENT_IMAGE_TTL_MS - 1));
  const validBeforeExpiry = cache.resolveForFollowUp({
    quotedPlatformMessageId: "img-old",
    targetText: "这是啥",
    now: t0 + RECENT_IMAGE_TTL_MS - 1,
  });
  assert.equal(validBeforeExpiry?.reason, "quoted");
  assert.equal(validBeforeExpiry?.entry.platformMessageId, "img-old");

  // Exactly at 10m TTL for img-old -> expired & pruned, img-mid still valid
  const expiredOld = cache.resolveForFollowUp({
    quotedPlatformMessageId: "img-old",
    targetText: "这是啥",
    now: t0 + RECENT_IMAGE_TTL_MS,
  });
  assert.equal(expiredOld, null);
  assert.equal(cache.size, 1);

  // Keyword follow-up still resolves img-mid before its own TTL
  const keywordMid = cache.resolveForFollowUp({
    targetText: "刚才那张图里写的什么",
    now: t0 + RECENT_IMAGE_TTL_MS + 1000,
  });
  assert.equal(keywordMid?.reason, "keyword");
  assert.equal(keywordMid?.entry.platformMessageId, "img-mid");

  // Remembering a much newer entry prunes expired ones
  cache.remember({
    platformMessageId: "img-fresh",
    createdAt: t0 + RECENT_IMAGE_TTL_MS + 400_000,
    images: [sampleImage("fresh")],
  });
  assert.deepEqual(cache.list(t0 + RECENT_IMAGE_TTL_MS + 400_000).map(e => e.platformMessageId), ["img-fresh"]);

  // Explicit prune removes expired fresh entry
  assert.equal(cache.prune(t0 + RECENT_IMAGE_TTL_MS + 400_000 + RECENT_IMAGE_TTL_MS), 1);
  assert.equal(cache.size, 0);
});

test("resolveForFollowUp distinguishes quoted recall, keyword follow-up recall, and unrelated chat", () => {
  const cache = new RecentImageCache();
  const baseTime = 5_000_000;
  cache.remember({
    messageRowId: 1,
    platformMessageId: "qq-101",
    createdAt: baseTime,
    images: [sampleImage("first")],
    caption: "报错日志",
  });
  cache.remember({
    messageRowId: 2,
    platformMessageId: "qq-102",
    createdAt: baseTime + 5000,
    images: [sampleImage("second-a"), sampleImage("second-b")],
  });

  // (a) Quoting an older image message recalls THAT specific image even without image keywords
  const quotedOlder = cache.resolveForFollowUp({
    quotedPlatformMessageId: "qq-101",
    targetText: "这个怎么解决",
    now: baseTime + 10_000,
  });
  assert.equal(quotedOlder?.reason, "quoted");
  assert.equal(quotedOlder?.entry.platformMessageId, "qq-101");
  assert.equal(quotedOlder?.images.length, 1);
  assert.equal(quotedOlder?.images[0]?.data, sampleImage("first").data);

  // (b) Explicit image follow-up keywords recall the latest image within TTL
  for (const phrase of [
    "看图",
    "帮我看下刚才那张",
    "上面那张是什么意思",
    "结合上下文的图说说",
    "图里第三行写的是啥",
    "这张图片能放大看吗",
    "截图里的版本号是多少",
  ]) {
    assert.equal(isImageFollowUpText(phrase), true, `expected match for: ${phrase}`);
    const hit = cache.resolveForFollowUp({ targetText: phrase, now: baseTime + 10_000 });
    assert.equal(hit?.reason, "keyword");
    assert.equal(hit?.entry.platformMessageId, "qq-102");
    assert.equal(hit?.images.length, 2);
  }

  // Quoting a non-image message (e.g., bot's text reply) + explicit image follow-up falls back to latest cached image
  const quotedBotWithKeyword = cache.resolveForFollowUp({
    quotedPlatformMessageId: "qq-bot-reply-999",
    targetText: "图里那个报错怎么修",
    now: baseTime + 10_000,
  });
  assert.equal(quotedBotWithKeyword?.reason, "keyword");
  assert.equal(quotedBotWithKeyword?.entry.platformMessageId, "qq-102");

  // Unrelated text (even when quoting a non-image message) does not recall images
  for (const nonImageText of [
    "",
    "今天中午吃什么",
    "刚才你说的那段话很有道理",
    "上面写着一行配置",
    "你有什么企图",
    "地图怎么看",
  ]) {
    assert.equal(isImageFollowUpText(nonImageText), false, `expected no match for: ${nonImageText}`);
    assert.equal(cache.resolveForFollowUp({
      quotedPlatformMessageId: "qq-text-only",
      targetText: nonImageText,
      now: baseTime + 10_000,
    }), null);
  }
});
