import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const decoded = (codes) => String.fromCharCode(...codes);
const ENV_TOKEN = decoded([46, 101, 110, 118]);
const SAFE_SUFFIXES = new Set(["example", "sample", "template"]);
const GUARD_MARKER = Symbol.for("qq-voice-room:environment-read-guard:v1");
const canonicalizePath = fs.realpathSync.native ?? fs.realpathSync;

function pathValue(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof URL) {
    if (value.protocol !== "file:") return null;
    return fileURLToPath(value);
  }
  return null;
}

export function isSensitiveEnvPath(value) {
  const candidate = pathValue(value);
  if (candidate === null) return false;
  const normalizedPath = candidate.replaceAll("\\", "/");
  const withoutDrive = normalizedPath.replace(/^[A-Za-z]:/, "");
  let basename = path.posix.basename(withoutDrive).toLowerCase();
  const streamSeparator = basename.indexOf(":");
  if (streamSeparator !== -1) basename = basename.slice(0, streamSeparator);
  basename = basename.replace(/[ .]+$/g, "");
  if (basename === ENV_TOKEN) return true;
  const prefix = `${ENV_TOKEN}.`;
  if (!basename.startsWith(prefix)) return false;
  return !SAFE_SUFFIXES.has(basename.slice(prefix.length));
}

function isSensitiveEnvTarget(value) {
  if (isSensitiveEnvPath(value)) return true;
  const candidate = pathValue(value);
  if (candidate === null) return false;
  try {
    return isSensitiveEnvPath(canonicalizePath(candidate));
  } catch {
    return false;
  }
}

function accessDenied(api, value) {
  const error = new Error(`environment-file access denied by ${api}`);
  error.code = "ERR_ACCESS_DENIED";
  error.errno = -13;
  error.path = pathValue(value) ?? String(value);
  return error;
}

function mark(wrapper) {
  Object.defineProperty(wrapper, GUARD_MARKER, { value: true });
  return wrapper;
}

function wrapSync(target, name) {
  const original = target[name];
  if (typeof original !== "function" || original[GUARD_MARKER]) return;
  target[name] = mark(function guardedSync(...args) {
    if (isSensitiveEnvTarget(args[0])) throw accessDenied(name, args[0]);
    return Reflect.apply(original, this, args);
  });
}

function wrapCallback(target, name) {
  const original = target[name];
  if (typeof original !== "function" || original[GUARD_MARKER]) return;
  target[name] = mark(function guardedCallback(...args) {
    if (isSensitiveEnvTarget(args[0])) {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        process.nextTick(callback, accessDenied(name, args[0]));
        return undefined;
      }
      throw accessDenied(name, args[0]);
    }
    return Reflect.apply(original, this, args);
  });
}

function wrapPromise(target, name) {
  const original = target[name];
  if (typeof original !== "function" || original[GUARD_MARKER]) return;
  target[name] = mark(async function guardedPromise(...args) {
    if (isSensitiveEnvTarget(args[0])) throw accessDenied(name, args[0]);
    return Reflect.apply(original, this, args);
  });
}

const originalLoadEnvFile = process.loadEnvFile;
if (typeof originalLoadEnvFile === "function") {
  process.loadEnvFile = mark(function guardedLoadEnvFile(filePath) {
    if (filePath === undefined || isSensitiveEnvTarget(filePath)) {
      throw accessDenied("process.loadEnvFile", filePath ?? "<default>");
    }
    return Reflect.apply(originalLoadEnvFile, this, arguments);
  });
}

for (const name of [
  "readFileSync",
  "openSync",
  "createReadStream",
  "copyFileSync",
  "cpSync"
]) {
  wrapSync(fs, name);
}
for (const name of ["readFile", "open", "copyFile", "cp"]) {
  wrapCallback(fs, name);
}
for (const name of ["readFile", "open", "copyFile", "cp"]) {
  wrapPromise(fsPromises, name);
}
for (const name of ["readFile", "open", "copyFile", "cp"]) {
  wrapPromise(fs.promises, name);
}
for (const name of ["openAsBlob"]) {
  wrapPromise(fs, name);
  wrapPromise(fsPromises, name);
  wrapPromise(fs.promises, name);
}
syncBuiltinESMExports();
