import assert from "node:assert/strict";
import test from "node:test";
import { inferBotStatusFromLogs, sendWechatPush, startQrPortal } from "../src/voice-room/qr-portal.js";

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

test("inferBotStatusFromLogs tracks chronological transitions cleanly", () => {
  assert.equal(inferBotStatusFromLogs("11-27 12:49:22 [info] [AdapterManager] 协议适配器初始化完成"), "online");
  assert.equal(
    inferBotStatusFromLogs([
      "11-27 12:49:22 [info] [AdapterManager] 协议适配器初始化完成",
      "11-28 00:30:06 [error] 月见露娜 | [KickedOffLine] [下线通知] 你的账号当前登录已失效，请重新登录。",
      "11-28 00:30:42 [warn] 请扫描下面的二维码，然后在手Q上授权登录：",
    ].join("\n")),
    "qr_wait",
  );
  assert.equal(
    inferBotStatusFromLogs([
      "11-28 00:30:42 [warn] 请扫描下面的二维码，然后在手Q上授权登录：",
      "11-28 00:35:00 [info] 登录成功",
      "11-28 00:36:00 [info] 接收 <- 群聊 测试",
    ].join("\n")),
    "online",
  );
  assert.equal(inferBotStatusFromLogs("random unrelated line"), "unknown");
});

test("sendWechatPush formats PushPlus JSON and ServerChan form payloads", async () => {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const isPushPlus = String(input).includes("pushplus");
    return new Response(JSON.stringify(isPushPlus ? { code: 200, msg: "ok" } : { code: 0, message: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const pp = await sendWechatPush({
    pushPlusToken: "pp-token-123",
    title: "测试标题",
    markdown: "测试内容",
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(pp, { sent: true, provider: "pushplus" });
  assert.equal(calls[0]!.url, "https://www.pushplus.plus/send");
  assert.deepEqual(JSON.parse(calls[0]!.body!), {
    token: "pp-token-123",
    title: "测试标题",
    content: "测试内容",
    template: "markdown",
  });

  const sc = await sendWechatPush({
    serverChanKey: "SCT12345",
    title: "标题B",
    markdown: "正文B",
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(sc, { sent: true, provider: "serverchan" });
  assert.equal(calls[1]!.url, "https://sctapi.ftqq.com/SCT12345.send");
  const parsedForm = new URLSearchParams(calls[1]!.body);
  assert.equal(parsedForm.get("title"), "标题B");
  assert.equal(parsedForm.get("desp"), "正文B");

  const none = await sendWechatPush({ title: "x", markdown: "y", fetchImpl: fakeFetch });
  assert.equal(none.sent, false);
  assert.equal(none.provider, "none");
});

test("qr-portal enforces accessToken, serves HTML/PNG, and merges simultaneous offline WeChat pushes with cooldown", async t => {
  const logs = new Map<string, string>([
    ["napcat-bot-a", "11-28 01:00:00 [info] 接收 <- 群聊 hello"],
    ["napcat-bot-b", "11-28 01:00:00 [info] 接收 <- 群聊 hello"],
  ]);
  const pushBodies: Array<{ title: string; content: string }> = [];
  let fakeNow = 1_000_000;
  const portal = await startQrPortal({
    port: 0,
    accessToken: "secret-portal-token",
    publicBaseUrl: "https://morrowave.me/vr-demo",
    pushPlusToken: "pp-demo-key",
    pollIntervalMs: 0,
    mergeDelayMs: 0,
    pushCooldownMs: 15 * 60_000,
    now: () => fakeNow,
    readLogs: async container => logs.get(container) ?? "",
    readQrPng: async container => container === "napcat-bot-a" ? FAKE_PNG : null,
    readQrMtime: async () => "2026/11/28 01:05:00",
    restartContainer: async () => {},
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      pushBodies.push(JSON.parse(String(init?.body)) as { title: string; content: string });
      return new Response(JSON.stringify({ code: 200 }), { status: 200 });
    }) as typeof fetch,
  });
  t.after(() => portal.close());

  // 1. Token gate
  const forbidden = await fetch(`${portal.url}/`);
  assert.equal(forbidden.status, 403);
  const wrongToken = await fetch(`${portal.url}/?k=wrong`);
  assert.equal(wrongToken.status, 403);

  // 2. HTML + PNG with valid token
  const okHtml = await fetch(`${portal.url}/?k=secret-portal-token`);
  assert.equal(okHtml.status, 200);
  const html = await okHtml.text();
  assert.ok(html.includes("月见露娜"));
  assert.ok(html.includes("朝雾凛"));

  const okPng = await fetch(`${portal.url}/qr/bot-a.png?k=secret-portal-token`);
  assert.equal(okPng.status, 200);
  assert.equal(okPng.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await okPng.arrayBuffer()), FAKE_PNG);

  const missingPng = await fetch(`${portal.url}/qr/bot-b.png?k=secret-portal-token`);
  assert.equal(missingPng.status, 404);

  // 3. Initial online baseline -> both drop simultaneously -> single merged push
  await portal.pollOnce();
  assert.equal(pushBodies.length, 0);

  logs.set("napcat-bot-a", "11-28 01:10:00 [warn] 请扫描下面的二维码");
  logs.set("napcat-bot-b", "11-28 01:10:01 [warn] 请扫描下面的二维码");
  await portal.pollOnce();
  assert.equal(pushBodies.length, 1);
  assert.ok(pushBodies[0]!.title.includes("月见露娜"));
  assert.ok(pushBodies[0]!.title.includes("朝雾凛"));
  assert.ok(pushBodies[0]!.content.includes("https://morrowave.me/vr-demo/?k=secret-portal-token"));

  // 4. Continued offline streak does not spam even after cooldown
  fakeNow += 20 * 60_000;
  await portal.pollOnce();
  assert.equal(pushBodies.length, 1);

  // 5. Recovery to online resets cooldown so a subsequent drop notifies again
  logs.set("napcat-bot-a", "11-28 01:31:00 [info] 登录成功");
  logs.set("napcat-bot-b", "11-28 01:31:00 [info] 登录成功");
  await portal.pollOnce();

  logs.set("napcat-bot-a", "11-28 03:32:00 [error] [KickedOffLine]");
  await portal.pollOnce();
  assert.equal(pushBodies.length, 2);
  assert.ok(pushBodies[1]!.title.includes("月见露娜"));
});
