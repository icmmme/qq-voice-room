import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { DEFAULT_DOCKER_QR_PATH, readQrCodePng } from "./qr-rescue.js";

export type BotLoginStatus = "online" | "qr_wait" | "unknown";

export interface QrPortalBotConfig {
  readonly id: string;
  readonly name: string;
  readonly container: string;
}

export const DEFAULT_QR_PORTAL_BOTS: readonly QrPortalBotConfig[] = Object.freeze([
  { id: "bot-a", name: "月见露娜", container: "napcat-bot-a" },
  { id: "bot-b", name: "朝雾凛", container: "napcat-bot-b" },
]);

export interface WechatPushResult {
  readonly sent: boolean;
  readonly provider: "pushplus" | "serverchan" | "none";
  readonly error?: string;
}

export interface QrPortalBotSnapshot {
  readonly id: string;
  readonly name: string;
  readonly container: string;
  readonly status: BotLoginStatus;
  readonly qrUpdatedAt: string | null;
}

export interface QrPortalConfig {
  port?: number;
  host?: string;
  accessToken: string;
  publicBaseUrl: string;
  bots?: readonly QrPortalBotConfig[];
  pushPlusToken?: string;
  serverChanKey?: string;
  pollIntervalMs?: number;
  pushCooldownMs?: number;
  mergeDelayMs?: number;
  restartCooldownMs?: number;
  readLogs?: (container: string) => Promise<string>;
  readQrPng?: (container: string) => Promise<Buffer | null>;
  readQrMtime?: (container: string) => Promise<string | null>;
  restartContainer?: (container: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const ONLINE_MARKERS = ["AdapterManager", "接收 <-", "发送 ->", "登录成功"] as const;
const QR_WAIT_MARKERS = ["请扫描下面的二维码", "二维码已保存到", "KickedOffLine", "账号状态变更为离线"] as const;

/** Infer latest login state from recent NapCat container logs chronologically. */
export function inferBotStatusFromLogs(logText: string): BotLoginStatus {
  let status: BotLoginStatus = "unknown";
  for (const rawLine of logText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (QR_WAIT_MARKERS.some(marker => line.includes(marker))) {
      status = "qr_wait";
    } else if (ONLINE_MARKERS.some(marker => line.includes(marker))) {
      status = "online";
    }
  }
  return status;
}

/** Send WeChat notification via PushPlus (preferred) or ServerChan without throwing. */
export async function sendWechatPush(params: {
  pushPlusToken?: string;
  serverChanKey?: string;
  title: string;
  markdown: string;
  fetchImpl?: typeof fetch;
}): Promise<WechatPushResult> {
  const pushPlusToken = params.pushPlusToken?.trim() ?? "";
  const serverChanKey = params.serverChanKey?.trim() ?? "";
  const fetchFn = params.fetchImpl ?? globalThis.fetch;

  if (pushPlusToken) {
    try {
      const response = await fetchFn("https://www.pushplus.plus/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: pushPlusToken,
          title: params.title,
          content: params.markdown,
          template: "markdown",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      if (!response.ok) {
        return { sent: false, provider: "pushplus", error: `http_${response.status}` };
      }
      try {
        const parsed = JSON.parse(text) as { code?: unknown; msg?: unknown };
        if (typeof parsed.code === "number" && parsed.code !== 200) {
          return { sent: false, provider: "pushplus", error: String(parsed.msg ?? `code_${parsed.code}`) };
        }
      } catch {
        // Non-JSON 200 still treated as accepted if HTTP status is ok.
      }
      return { sent: true, provider: "pushplus" };
    } catch (error) {
      return {
        sent: false,
        provider: "pushplus",
        error: error instanceof Error ? error.message : "request_failed",
      };
    }
  }

  if (serverChanKey) {
    try {
      const body = new URLSearchParams({
        title: params.title,
        desp: params.markdown,
      }).toString();
      const response = await fetchFn(`https://sctapi.ftqq.com/${encodeURIComponent(serverChanKey)}.send`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      if (!response.ok) {
        return { sent: false, provider: "serverchan", error: `http_${response.status}` };
      }
      try {
        const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof parsed.code === "number" && parsed.code !== 0) {
          return { sent: false, provider: "serverchan", error: String(parsed.message ?? `code_${parsed.code}`) };
        }
      } catch {
        // Non-JSON 200 still treated as accepted if HTTP status is ok.
      }
      return { sent: true, provider: "serverchan" };
    } catch (error) {
      return {
        sent: false,
        provider: "serverchan",
        error: error instanceof Error ? error.message : "request_failed",
      };
    }
  }

  return { sent: false, provider: "none", error: "not-configured" };
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPortalUrl(baseUrl: string, accessToken: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return `${normalized}/?k=${encodeURIComponent(accessToken)}`;
}

function dockerSocketRequest(path: string, method: "GET" | "POST", timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: "/var/run/docker.sock", path, method }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`docker_http_${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("docker_socket_timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

function decodeDockerLogStream(raw: Buffer): string {
  if (raw.byteLength < 8 || (raw[0] !== 1 && raw[0] !== 2) || raw[1] !== 0 || raw[2] !== 0 || raw[3] !== 0) {
    return raw.toString("utf8");
  }
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= raw.byteLength) {
    const stream = raw[offset];
    if ((stream !== 1 && stream !== 2) || raw[offset + 1] !== 0 || raw[offset + 2] !== 0 || raw[offset + 3] !== 0) {
      return raw.toString("utf8");
    }
    const size = raw.readUInt32BE(offset + 4);
    offset += 8;
    const end = Math.min(offset + size, raw.byteLength);
    parts.push(raw.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return parts.join("");
}

async function defaultReadLogs(container: string): Promise<string> {
  try {
    const raw = await dockerSocketRequest(
      `/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&tail=120`,
      "GET",
      4000,
    );
    return decodeDockerLogStream(raw);
  } catch {
    return "";
  }
}

async function defaultReadQrMtime(): Promise<string | null> {
  return null;
}

async function defaultRestartContainer(container: string): Promise<void> {
  await dockerSocketRequest(`/containers/${encodeURIComponent(container)}/restart?t=5`, "POST", 15_000);
}

function renderHtmlPage(params: {
  token: string;
  snapshots: readonly QrPortalBotSnapshot[];
  pushConfigured: boolean;
  cacheTs: number;
}): string {
  const encodedToken = encodeURIComponent(params.token);
  const cards = params.snapshots.map(bot => {
    const statusLabel = bot.status === "online" ? "在线" : bot.status === "qr_wait" ? "待扫码" : "检测中";
    const statusClass = bot.status === "online" ? "badge-online" : bot.status === "qr_wait" ? "badge-qr" : "badge-unknown";
    const qrSrc = `qr/${encodeURIComponent(bot.id)}.png?k=${encodedToken}&t=${params.cacheTs}`;
    const downloadName = `${bot.id}-qr.png`;
    const mtimeText = bot.qrUpdatedAt ? `二维码生成时间：${escapeHtml(bot.qrUpdatedAt)}` : "暂无二维码文件（若刚上线可忽略）";
    const qrSection = bot.status === "online"
      ? `<div class="online-note">当前账号在线，无需扫码。如遇假死可直接点下方按钮重启刷新。</div>`
      : `<div class="qr-box">
           <img class="qr-img" data-bot="${escapeHtml(bot.id)}" src="${qrSrc}" alt="${escapeHtml(bot.name)} 二维码" onerror="this.style.display='none'" />
           <div class="mtime" data-mtime="${escapeHtml(bot.id)}">${mtimeText}</div>
         </div>`;

    return `<section class="card" data-card="${escapeHtml(bot.id)}">
      <div class="card-head">
        <div>
          <h2>${escapeHtml(bot.name)}</h2>
          <div class="sub">${escapeHtml(bot.container)}</div>
        </div>
        <span class="badge ${statusClass}" data-badge="${escapeHtml(bot.id)}">${statusLabel}</span>
      </div>
      ${qrSection}
      <div class="actions">
        <a class="btn btn-secondary" href="qr/${encodeURIComponent(bot.id)}.png?k=${encodedToken}" download="${escapeHtml(downloadName)}">保存二维码</a>
        <button class="btn btn-primary" onclick="restartBot('${escapeHtml(bot.id)}', this)">重启并刷新二维码</button>
      </div>
    </section>`;
  }).join("\n");

  const pushBadge = params.pushConfigured
    ? `<span class="push-ok">微信推送已配置</span>`
    : `<span class="push-off">微信推送未配置（仅网页扫码可用）</span>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>QQ VoiceRoom 登录状态与扫码</title>
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#2f81f7; --ok:#238636; --warn:#d29922; }
    * { box-sizing:border-box; }
    body { margin:0; padding:16px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); }
    .wrap { max-width:560px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
    header { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
    h1 { font-size:18px; margin:0; }
    .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:12px; }
    .card-head { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    h2 { font-size:16px; margin:0; }
    .sub { font-size:12px; color:var(--muted); margin-top:2px; }
    .badge { font-size:12px; font-weight:600; padding:4px 10px; border-radius:999px; }
    .badge-online { background:rgba(35,134,54,.22); color:#3fb950; border:1px solid rgba(63,185,80,.4); }
    .badge-qr { background:rgba(210,153,34,.2); color:#e3b341; border:1px solid rgba(227,179,65,.45); }
    .badge-unknown { background:rgba(139,148,158,.2); color:var(--muted); border:1px solid var(--border); }
    .qr-box { display:flex; flex-direction:column; align-items:center; gap:8px; background:#fff; padding:14px; border-radius:10px; }
    .qr-img { width:220px; height:220px; image-rendering:pixelated; display:block; }
    .mtime { font-size:12px; color:#57606a; text-align:center; }
    .online-note { font-size:13px; color:var(--muted); padding:10px 12px; background:rgba(255,255,255,.03); border-radius:8px; }
    .actions { display:flex; gap:10px; flex-wrap:wrap; }
    .btn { flex:1; min-width:130px; text-align:center; text-decoration:none; border:none; border-radius:8px; padding:10px 12px; font-size:14px; font-weight:600; cursor:pointer; }
    .btn-primary { background:var(--accent); color:#fff; }
    .btn-secondary { background:#21262d; color:var(--text); border:1px solid var(--border); }
    .btn:disabled { opacity:.55; cursor:not-allowed; }
    .tip { font-size:13px; color:var(--muted); line-height:1.55; }
    .footer { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--muted); }
    .push-ok { color:#3fb950; }
    .push-off { color:var(--warn); }
    #toast { font-size:13px; color:#79c0ff; min-height:18px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>QQ VoiceRoom 扫码恢复</h1>
      ${pushBadge}
    </header>
    <div id="toast"></div>
    ${cards}
    <section class="card">
      <div class="tip">
        <strong>单手机扫码步骤：</strong>点「保存二维码」（或直接手机截屏）→ 打开手机 QQ 右上角 <strong>+</strong> → <strong>扫一扫</strong> → 右下角<strong>相册</strong>选中二维码图片 → 确认登录。页面每 15 秒自动刷新。
      </div>
      <div class="footer">
        <span id="last-sync">页面加载于 ${escapeHtml(new Date(params.cacheTs).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))}</span>
        <button class="btn btn-secondary" style="flex:0 0 auto;min-width:auto;padding:8px 12px;" onclick="testPush(this)">发送测试微信推送</button>
      </div>
    </section>
  </div>
  <script>
    const TOKEN = ${JSON.stringify(params.token)};
    function setToast(msg) { document.getElementById('toast').textContent = msg; }
    async function refreshStatus() {
      try {
        const res = await fetch('api/status?k=' + encodeURIComponent(TOKEN), { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const ts = Date.now();
        for (const bot of data.bots || []) {
          const badge = document.querySelector('[data-badge="' + bot.id + '"]');
          if (badge) {
            badge.textContent = bot.status === 'online' ? '在线' : bot.status === 'qr_wait' ? '待扫码' : '检测中';
            badge.className = 'badge ' + (bot.status === 'online' ? 'badge-online' : bot.status === 'qr_wait' ? 'badge-qr' : 'badge-unknown');
          }
          const img = document.querySelector('img[data-bot="' + bot.id + '"]');
          if (img) {
            img.style.display = 'block';
            img.src = 'qr/' + encodeURIComponent(bot.id) + '.png?k=' + encodeURIComponent(TOKEN) + '&t=' + ts;
          }
          const mt = document.querySelector('[data-mtime="' + bot.id + '"]');
          if (mt && bot.qrUpdatedAt) mt.textContent = '二维码生成时间：' + bot.qrUpdatedAt;
        }
        document.getElementById('last-sync').textContent = '最近刷新 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
      } catch {}
    }
    async function restartBot(id, btn) {
      btn.disabled = true;
      setToast('正在重启 ' + id + '，请等待约 8 秒生成新二维码...');
      try {
        const res = await fetch('restart/' + encodeURIComponent(id) + '?k=' + encodeURIComponent(TOKEN), { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setToast(data.error || '操作过于频繁，请稍后再试');
        } else {
          setTimeout(() => { location.reload(); }, 8000);
          return;
        }
      } catch {
        setToast('请求失败，请稍后重试');
      }
      btn.disabled = false;
    }
    async function testPush(btn) {
      btn.disabled = true;
      setToast('正在发送测试推送...');
      try {
        const res = await fetch('test-push?k=' + encodeURIComponent(TOKEN), { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        setToast(data.sent ? '测试推送已发送（' + data.provider + '）' : '未发送：' + (data.error || '请检查推送配置'));
      } catch {
        setToast('测试推送请求失败');
      }
      btn.disabled = false;
    }
    setInterval(refreshStatus, 15000);
  </script>
</body>
</html>`;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Connection": "close",
  });
  res.end(payload);
}

/**
 * Start token-protected local QR recovery HTTP portal and debounced WeChat offline notifier.
 */
export async function startQrPortal(config: QrPortalConfig) {
  const accessToken = config.accessToken.trim();
  if (!accessToken) throw new Error("qr-portal-token-missing");
  const host = config.host?.trim() || "127.0.0.1";
  const port = config.port ?? 3012;
  const bots = config.bots?.length ? config.bots : DEFAULT_QR_PORTAL_BOTS;
  const pollIntervalMs = config.pollIntervalMs ?? 30_000;
  const pushCooldownMs = config.pushCooldownMs ?? 15 * 60_000;
  const mergeDelayMs = config.mergeDelayMs ?? 3_000;
  const restartCooldownMs = config.restartCooldownMs ?? 20_000;
  const now = config.now ?? (() => Date.now());
  const readLogs = config.readLogs ?? defaultReadLogs;
  const readQrPng = config.readQrPng
    ?? ((container: string) => readQrCodePng({ kind: "docker", container, path: DEFAULT_DOCKER_QR_PATH }));
  const readQrMtime = config.readQrMtime ?? defaultReadQrMtime;
  const restartContainer = config.restartContainer ?? defaultRestartContainer;
  const pushConfigured = Boolean(config.pushPlusToken?.trim() || config.serverChanKey?.trim());

  const lastStatus = new Map<string, BotLoginStatus>();
  const alertedStreak = new Set<string>();
  const pendingPushBots = new Set<string>();
  const restartAt = new Map<string, number>();
  let lastPushAt = -Infinity;
  let mergeTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let cachedSnapshots: QrPortalBotSnapshot[] | undefined;
  let cachedAt = -Infinity;
  let inFlightSnapshots: Promise<QrPortalBotSnapshot[]> | undefined;

  async function collectSnapshots(force = false): Promise<QrPortalBotSnapshot[]> {
    if (!force && cachedSnapshots && now() - cachedAt < 5_000) {
      return cachedSnapshots;
    }
    if (!force && inFlightSnapshots) {
      return inFlightSnapshots;
    }
    const work = Promise.all(bots.map(async bot => {
      const [logs, mtime] = await Promise.all([readLogs(bot.container), readQrMtime(bot.container)]);
      return {
        id: bot.id,
        name: bot.name,
        container: bot.container,
        status: inferBotStatusFromLogs(logs),
        qrUpdatedAt: mtime,
      };
    })).then(snaps => {
      cachedSnapshots = snaps;
      cachedAt = now();
      return snaps;
    }).finally(() => {
      if (inFlightSnapshots === work) inFlightSnapshots = undefined;
    });
    inFlightSnapshots = work;
    return work;
  }

  async function flushMergedPush(): Promise<WechatPushResult | null> {
    mergeTimer = undefined;
    if (closing || pendingPushBots.size === 0) return null;
    const snapshots = await collectSnapshots(true);
    const targetIds = new Set<string>();
    for (const botId of pendingPushBots) targetIds.add(botId);
    for (const snap of snapshots) {
      if (snap.status === "qr_wait" && !alertedStreak.has(snap.id)) targetIds.add(snap.id);
    }
    pendingPushBots.clear();
    if (targetIds.size === 0) return null;

    const offlineNames = snapshots
      .filter(s => targetIds.has(s.id) && s.status === "qr_wait")
      .map(s => s.name);
    if (offlineNames.length === 0) return null;

    for (const snap of snapshots) {
      if (targetIds.has(snap.id) && snap.status === "qr_wait") alertedStreak.add(snap.id);
    }
    lastPushAt = now();
    const portalUrl = buildPortalUrl(config.publicBaseUrl, accessToken);
    const title = `QQ VoiceRoom 需要扫码登录（${offlineNames.join("、")}）`;
    const markdown = [
      `检测到离线账号：**${offlineNames.join("、")}**`,
      "",
      `[点击打开扫码恢复页](${portalUrl})`,
      "",
      `二维码每约 2 分钟更新一次；单手机请保存/截屏后用手机 QQ「扫一扫 -> 相册」扫码登录。`,
    ].join("\n");
    return sendWechatPush({
      pushPlusToken: config.pushPlusToken,
      serverChanKey: config.serverChanKey,
      title,
      markdown,
      fetchImpl: config.fetchImpl,
    });
  }

  async function pollOnce(): Promise<QrPortalBotSnapshot[]> {
    const snapshots = await collectSnapshots(true);
    const allOnline = snapshots.length > 0 && snapshots.every(s => s.status === "online");
    if (allOnline) {
      lastPushAt = -Infinity;
      alertedStreak.clear();
      pendingPushBots.clear();
      if (mergeTimer) { clearTimeout(mergeTimer); mergeTimer = undefined; }
    }

    let shouldSchedule = false;
    for (const snap of snapshots) {
      const prev = lastStatus.get(snap.id);
      lastStatus.set(snap.id, snap.status);
      if (snap.status === "online") {
        alertedStreak.delete(snap.id);
        pendingPushBots.delete(snap.id);
        continue;
      }
      if (snap.status === "qr_wait" && !alertedStreak.has(snap.id)) {
        const newlyDroppedFromOnline = prev === "online";
        const cooldownPassed = now() - lastPushAt >= pushCooldownMs;
        if (newlyDroppedFromOnline || cooldownPassed) {
          pendingPushBots.add(snap.id);
          shouldSchedule = true;
        }
      }
    }

    if (shouldSchedule && !mergeTimer && !closing) {
      if (mergeDelayMs <= 0) {
        await flushMergedPush();
      } else {
        mergeTimer = setTimeout(() => { void flushMergedPush(); }, mergeDelayMs);
        mergeTimer.unref();
      }
    }
    return snapshots;
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const providedToken = reqUrl.searchParams.get("k");
      if (!tokenMatches(providedToken, accessToken)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }

      const rawPath = reqUrl.pathname;
      const pathname = rawPath === "" || rawPath === "/" ? "/" : rawPath.replace(/\/+$/, "");

      if (req.method === "GET" && pathname === "/") {
        const snapshots = await collectSnapshots();
        const html = renderHtmlPage({
          token: accessToken,
          snapshots,
          pushConfigured,
          cacheTs: now(),
        });
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Connection": "close",
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        const snapshots = await collectSnapshots();
        sendJson(res, 200, { bots: snapshots, pushConfigured });
        return;
      }

      const qrMatch = req.method === "GET" ? pathname.match(/^\/qr\/([a-zA-Z0-9_-]+)\.png$/) : null;
      if (qrMatch) {
        const bot = bots.find(b => b.id === qrMatch[1]);
        if (!bot) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        const png = await readQrPng(bot.container);
        if (!png) {
          sendJson(res, 404, { error: "qr_unavailable" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(png.byteLength),
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Connection": "close",
        });
        res.end(png);
        return;
      }

      const restartMatch = req.method === "POST" ? pathname.match(/^\/restart\/([a-zA-Z0-9_-]+)$/) : null;
      if (restartMatch) {
        const bot = bots.find(b => b.id === restartMatch[1]);
        if (!bot) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        const elapsed = now() - (restartAt.get(bot.id) ?? -Infinity);
        if (elapsed < restartCooldownMs) {
          sendJson(res, 429, { error: "重启过于频繁，请 20 秒后再试" });
          return;
        }
        restartAt.set(bot.id, now());
        cachedSnapshots = undefined;
        cachedAt = -Infinity;
        await restartContainer(bot.container);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && pathname === "/test-push") {
        const portalUrl = buildPortalUrl(config.publicBaseUrl, accessToken);
        const result = await sendWechatPush({
          pushPlusToken: config.pushPlusToken,
          serverChanKey: config.serverChanKey,
          title: "QQ VoiceRoom 推送测试",
          markdown: `这是一条测试推送。\n\n[点击打开扫码恢复页](${portalUrl})`,
          fetchImpl: config.fetchImpl,
        });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    }
  });

  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  const connections = new Set<Socket>();
  server.on("connection", socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const pollTimer = pollIntervalMs > 0
    ? setInterval(() => { void pollOnce(); }, pollIntervalMs)
    : undefined;
  pollTimer?.unref();
  if (pollIntervalMs > 0) void pollOnce();

  const boundPort = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${boundPort}`,
    pollOnce,
    flushMergedPush,
    close: async () => {
      closing = true;
      if (pollTimer) clearInterval(pollTimer);
      if (mergeTimer) { clearTimeout(mergeTimer); mergeTimer = undefined; }
      await new Promise<void>((resolve, reject) => {
        for (const s of connections) s.destroy();
        server.close(err => err ? reject(err) : resolve());
      });
    },
  };
}
