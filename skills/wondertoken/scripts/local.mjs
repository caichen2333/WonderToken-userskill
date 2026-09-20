import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
export const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const stateRoot = process.env.WONDERTOKEN_STATE_DIR ?? join(homedir(), ".wondertoken");
let windowsSid;
export async function protect(path, directory = false) {
  if (process.platform !== "win32") return chmod(path, directory ? 0o700 : 0o600);
  windowsSid ??= (await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"])).stdout.trim();
  if (!/^S-1-\d+(?:-\d+)+$/.test(windowsSid)) throw new Error("WINDOWS_IDENTITY_UNAVAILABLE");
  await execute("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${windowsSid}:${directory ? "(OI)(CI)" : ""}F`]);
}
export async function ensureStateDirectory() {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await protect(stateRoot, true);
}
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function validateMcpUrl(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error("INVALID_MCP_URL");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("REMOTE_MCP_REQUIRES_HTTPS");
  }
  return url.href.replace(/\/$/, "");
}
export async function connectionConfig(explicitUrl) {
  let value = explicitUrl ?? process.env.WONDERTOKEN_MCP_URL;
  if (!value) value = (await readJson(join(stateRoot, "config.json")))?.mcpUrl;
  if (!value) value = (await readJson(join(skillRoot, "defaults.json")))?.mcpUrl;
  if (!value) throw new Error("WONDERTOKEN_MCP_URL_NOT_CONFIGURED");
  return { mcpUrl: validateMcpUrl(value) };
}

export async function localConnection() {
  const identity = await readJson(join(stateRoot, "player.json"));
  if (!/^[a-f0-9]{64}$/.test(identity?.playerKey ?? "")) throw new Error("PLAYER_IDENTITY_NOT_FOUND");
  return { playerKey: identity.playerKey, ...await connectionConfig() };
}
export async function withStateLock(name, work) {
  await ensureStateDirectory();
  const lock = join(stateRoot, `${name}.lock`);
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, "owner.tmp"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      await rename(join(lock, "owner.tmp"), join(lock, "owner.json"));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readJson(join(lock, "owner.json"));
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (probe) {
          if (probe.code === "ESRCH") {
            // A dead process leaves the lock. Rename would race with another
            // contender; removal is serialized by a recovery subdirectory.
            try {
              await mkdir(join(lock, "recovery"));
              const current = await readJson(join(lock, "owner.json"));
              if (current?.pid === owner.pid) await rm(lock, { recursive: true, force: true });
              else await rm(join(lock, "recovery"), { recursive: true, force: true });
            } catch (recovery) { if (recovery.code !== "EEXIST" && recovery.code !== "ENOENT") throw recovery; }
            continue;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error("LOCAL_STATE_BUSY_RETRY");
      await delay(100);
    }
  }
  try { return await work(); } finally { await rm(lock, { recursive: true, force: true }); }
}
export function errorDetails(error) {
  const pending = [error], seen = new Set(), codes = [];
  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (["EPERM", "EACCES", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(current.code)) codes.push(current.code);
    pending.push(current.cause, ...(Array.isArray(current.errors) ? current.errors : []));
  }
  const network = error?.message === "fetch failed" || codes.length > 0;
  const denied = codes.includes("EPERM") || codes.includes("EACCES");
  return {
    error: denied ? "LOCAL_PERMISSION_DENIED" : error?.message ?? "WONDERTOKEN_FAILED",
    ...(network ? { causeCodes: [...new Set(codes)], recovery: denied ? "request_host_permission" : "check_connection",
      ...(denied ? { serviceStatus: "unknown" } : {}) } : {}),
  };
}
export async function cli(main) {
  try { await main(); }
  catch (error) { console.error(JSON.stringify(errorDetails(error))); process.exitCode = 1; }
}

export function isMain(url) {
  if (!process.argv[1]) return false;
  try {
    const actual = realpathSync(process.argv[1]), entry = fileURLToPath(url);
    return process.platform === "win32" ? entry.toLowerCase() === actual.toLowerCase() : entry === actual;
  } catch { return false; }
}
