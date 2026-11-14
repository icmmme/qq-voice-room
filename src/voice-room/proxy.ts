import { spawnSync } from "node:child_process";
import * as http from "node:http";

export type RoomProxySource = "environment" | "windows-system" | "direct";

export interface RoomProxySummary {
  readonly source: RoomProxySource;
  readonly enabled: boolean;
  readonly bypassRuleCount: number;
  readonly ignoredBypassRuleCount: number;
}

export interface WindowsProxySettings {
  readonly enabled: boolean;
  readonly server?: string;
  readonly override?: string;
  readonly autoConfigUrl?: string;
}

export interface RoomProxyDiscovery {
  readonly summary: RoomProxySummary;
  readonly activationEnv: Readonly<Record<string, string>>;
}

export type RoomProxyFailure =
  | "env-invalid"
  | "env-unsupported"
  | "system-read-failed"
  | "system-invalid"
  | "system-pac-unsupported"
  | "system-socks-unsupported"
  | "runtime-unsupported"
  | "apply-failed";

export class RoomProxyError extends Error {
  constructor(readonly code: RoomProxyFailure) {
    super(`room-proxy-${code}`);
    this.name = "RoomProxyError";
  }
}

interface ProxyRuntime {
  setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => () => void;
}

interface DiscoveryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly readSystemProxy?: () => WindowsProxySettings;
}

const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1"] as const;

function ipv4WildcardRange(value: string): string | undefined {
  const match = /^((?:\d{1,3}\.){1,3})\*$/.exec(value);
  if (!match) return undefined;
  const octets = match[1]!.slice(0, -1).split(".");
  if (octets.some(octet => Number(octet) > 255)) return undefined;
  const missing = 4 - octets.length;
  const lower = [...octets, ...Array<string>(missing).fill("0")].join(".");
  const upper = [...octets, ...Array<string>(missing).fill("255")].join(".");
  return `${lower}-${upper}`;
}

function configuredProxy(env: NodeJS.ProcessEnv, protocol: "http" | "https"): string | undefined {
  const lower = `${protocol}_proxy`;
  const upper = `${protocol.toUpperCase()}_PROXY`;
  const raw = env[lower] || env[upper];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) throw new RoomProxyError("env-invalid");
  return normalizeProxy(value, "env");
}

function normalizeProxy(value: string, source: "env" | "system"): string {
  if (/^socks(?:4a?|5h?)?:/i.test(value)) {
    throw new RoomProxyError(source === "system" ? "system-socks-unsupported" : "env-unsupported");
  }
  const separator = value.indexOf("://");
  if (separator <= 0) {
    throw new RoomProxyError(source === "system" ? "system-invalid" : "env-invalid");
  }
  // Node's proxy parser accepts only lowercase http:// and https:// prefixes.
  const normalized = `${value.slice(0, separator).toLowerCase()}://${value.slice(separator + 3)}`;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new RoomProxyError(source === "system" ? "system-invalid" : "env-invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname
    || (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new RoomProxyError(source === "system" ? "system-invalid" : "env-unsupported");
  }
  return normalized;
}

function splitBypass(value: string | undefined): { supported: string[]; ignored: number } {
  if (!value) return { supported: [], ignored: 0 };
  const supported: string[] = [];
  let ignored = 0;
  for (const part of value.split(/[;,\s]+/).map(value => value.trim()).filter(Boolean)) {
    const range = ipv4WildcardRange(part);
    if (part === "*") supported.push(part);
    else if (range) supported.push(range);
    else if (part.startsWith("*.")) supported.push(`.${part.slice(2)}`);
    else if (/^\.(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)$/i.test(part)) supported.push(part);
    else if (/^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|[0-9a-f:.]+)(?::\d+)?$/i.test(part)) supported.push(part);
    else ignored++;
  }
  return { supported, ignored };
}

function bypassRules(...values: Array<string | undefined>): { rules: string[]; ignored: number } {
  const parsed = values.map(splitBypass);
  const supported = parsed.flatMap(value => value.supported);
  return {
    rules: supported.includes("*") ? ["*"] : [...new Set([...supported, ...LOOPBACK_BYPASS])],
    ignored: parsed.reduce((sum, value) => sum + value.ignored, 0),
  };
}

function systemProxyFromRegistry(): WindowsProxySettings {
  const result = spawnSync("reg.exe", [
    "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
  ], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (result.error || result.status !== 0) throw new RoomProxyError("system-read-failed");
  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL)\s+REG_(?:DWORD|SZ)\s+(.*?)\s*$/.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  const enabled = (() => {
    const raw = values.get("ProxyEnable");
    if (!raw) return false;
    const parsed = /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed)) throw new RoomProxyError("system-invalid");
    return parsed !== 0;
  })();
  return {
    enabled,
    ...(values.get("ProxyServer") ? { server: values.get("ProxyServer") } : {}),
    ...(values.get("ProxyOverride") ? { override: values.get("ProxyOverride") } : {}),
    ...(values.get("AutoConfigURL") ? { autoConfigUrl: values.get("AutoConfigURL") } : {}),
  };
}

function windowsProxyUrl(value: string, source: "system"): string {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  return normalizeProxy(candidate, source);
}

function parseWindowsServer(server: string): { http?: string; https?: string } {
  const entries = server.split(";").map(v => v.trim()).filter(Boolean);
  if (!entries.length) throw new RoomProxyError("system-invalid");
  if (entries.length === 1 && !entries[0]!.includes("=")) {
    const proxy = windowsProxyUrl(entries[0]!, "system");
    return { http: proxy, https: proxy };
  }
  const mapped = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) throw new RoomProxyError("system-invalid");
    const protocol = entry.slice(0, separator).trim().toLowerCase();
    const value = entry.slice(separator + 1).trim();
    if (protocol === "socks") throw new RoomProxyError("system-socks-unsupported");
    if (!["http", "https"].includes(protocol)) throw new RoomProxyError("system-invalid");
    mapped.set(protocol, windowsProxyUrl(value, "system"));
  }
  if (!mapped.has("http") && !mapped.has("https")) throw new RoomProxyError("system-invalid");
  return {
    ...(mapped.has("http") ? { http: mapped.get("http") } : {}),
    ...(mapped.has("https") ? { https: mapped.get("https") } : {}),
  };
}

function environmentProxy(env: NodeJS.ProcessEnv): RoomProxyDiscovery | undefined {
  const httpProxy = configuredProxy(env, "http");
  const httpsProxy = configuredProxy(env, "https");
  if (!httpProxy && !httpsProxy) return undefined;
  const bypass = bypassRules(env.no_proxy || env.NO_PROXY);
  return {
    summary: { source: "environment", enabled: true, bypassRuleCount: bypass.rules.length,
      ignoredBypassRuleCount: bypass.ignored },
    activationEnv: {
      ...(httpProxy ? { HTTP_PROXY: httpProxy } : {}),
      ...(httpsProxy ? { HTTPS_PROXY: httpsProxy } : {}),
      NO_PROXY: bypass.rules.join(","),
    },
  };
}

/**
 * Discover proxy configuration once at process startup. Values remain internal so
 * callers can log only the source, enabled state, and bypass-rule count.
 */
export function discoverRoomProxy(options: DiscoveryOptions = {}): RoomProxyDiscovery {
  const env = options.env ?? process.env;
  const explicit = environmentProxy(env);
  if (explicit) return explicit;
  if ((options.platform ?? process.platform) !== "win32") {
    return { summary: { source: "direct", enabled: false, bypassRuleCount: 0, ignoredBypassRuleCount: 0 },
      activationEnv: {} };
  }
  const system = (options.readSystemProxy ?? systemProxyFromRegistry)();
  if (system.autoConfigUrl) throw new RoomProxyError("system-pac-unsupported");
  if (!system.enabled) {
    return { summary: { source: "direct", enabled: false, bypassRuleCount: 0, ignoredBypassRuleCount: 0 },
      activationEnv: {} };
  }
  if (!system.server) throw new RoomProxyError("system-invalid");
  const proxies = parseWindowsServer(system.server);
  const bypass = bypassRules(env.no_proxy || env.NO_PROXY, system.override);
  return {
    summary: { source: "windows-system", enabled: true, bypassRuleCount: bypass.rules.length,
      ignoredBypassRuleCount: bypass.ignored },
    activationEnv: {
      ...(proxies.http ? { HTTP_PROXY: proxies.http } : {}),
      ...(proxies.https ? { HTTPS_PROXY: proxies.https } : {}),
      NO_PROXY: bypass.rules.join(","),
    },
  };
}

/**
 * Enable once before creating runtime services. Node 24.14+ exposes this API.
 * Older supported Node versions fail closed instead of silently going direct.
 */
export function activateRoomProxy(discovery: RoomProxyDiscovery, runtime: ProxyRuntime = http as ProxyRuntime): () => void {
  if (!discovery.summary.enabled) return () => {};
  const setGlobalProxyFromEnv = runtime.setGlobalProxyFromEnv;
  if (typeof setGlobalProxyFromEnv !== "function") throw new RoomProxyError("runtime-unsupported");
  let restored = false;
  let restore: () => void;
  try {
    restore = setGlobalProxyFromEnv({ ...discovery.activationEnv });
  } catch {
    throw new RoomProxyError("apply-failed");
  }
  return () => {
    if (restored) return;
    restored = true;
    restore();
  };
}
