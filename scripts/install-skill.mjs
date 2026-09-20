#!/usr/bin/env node
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { npmCommand, run } from "../skills/wondertoken/scripts/runtime.mjs";
import { validateMcpUrl, isMain } from "../skills/wondertoken/scripts/local.mjs";
import { releaseFingerprint } from "../skills/wondertoken/scripts/installation.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/wondertoken");
export const targets = { codex: [".agents", "skills"] };
function nested(parent, child) { const path = relative(parent, child); return !path || (!path.startsWith("..") && !isAbsolute(path)); }

export async function install({ agent = "codex", target, url, uninstall = false, dependencies = true }) {
  if (!target && !targets[agent]) throw new Error("ONLY_CODEX_IS_SUPPORTED");
  const destination = target ? resolve(target) : join(homedir(), ...targets[agent], "wondertoken");
  if (nested(source, destination) || nested(destination, source)) throw new Error("INSTALL_TARGET_OVERLAPS_SOURCE");
  const marker = join(destination, ".wondertoken-install.json");
  let existing;
  try { existing = JSON.parse(await readFile(marker, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let exists = false;
  try { await access(destination); exists = true; } catch {}
  if (exists && existing?.name !== "wondertoken") throw new Error("TARGET_EXISTS_NOT_MANAGED_BY_WONDERTOKEN");
  if (uninstall) {
    if (existing) await rm(destination, { recursive: true });
    return { uninstalled: Boolean(existing), identityPreserved: true, destination };
  }
  if (!/^24\./.test(process.versions.node) || Number(process.versions.node.split(".")[1]) < 14) {
    throw new Error("NODE_24_14_OR_NEWER_24_REQUIRED");
  }
  if (url) validateMcpUrl(url);
  await mkdir(dirname(destination), { recursive: true });
  const stage = await mkdtemp(join(dirname(destination), ".wondertoken-stage-"));
  const backup = `${stage}-previous`;
  try {
    await cp(source, stage, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes("node_modules") });
    const oldDefaults = existing ? JSON.parse(await readFile(join(destination, "defaults.json"), "utf8")) : null;
    if (oldDefaults?.mcpUrl) await writeFile(join(stage, "defaults.json"), JSON.stringify(oldDefaults, null, 2) + "\n");
    const release = await releaseFingerprint(stage);
    const { version } = JSON.parse(await readFile(join(stage, "package.json"), "utf8"));
    await writeFile(join(stage, ".wondertoken-install.json"), JSON.stringify({ name: "wondertoken", version, release }));
    if (dependencies) {
      const npm = await npmCommand();
      await run(npm.command, [...npm.prefix, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, timeout: 180_000 });
    }
    if (existing) await rename(destination, backup);
    try { await rename(stage, destination); }
    catch (error) { if (existing) await rename(backup, destination); throw error; }
    if (existing) await rm(backup, { recursive: true });
    if (url) await run(process.execPath, [join(destination, "scripts/setup.mjs"), "configure", "--url", url]);
    let serviceConfigured = false;
    try {
      const installedConfig = await import(pathToFileURL(join(destination, "scripts/local.mjs")).href);
      await installedConfig.connectionConfig();
      serviceConfigured = true;
    } catch (error) {
      if (error.message !== "WONDERTOKEN_MCP_URL_NOT_CONFIGURED") throw error;
    }
    return { installed: true, destination, identityPreserved: true, serviceConfigured, release };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function runCli() {
  const args = process.argv.slice(2); const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--uninstall") options.uninstall = true;
    else if (["--target", "--url"].includes(args[index]) && args[index + 1]) options[args[index++].slice(2)] = args[index];
    else throw new Error("USAGE: install-skill.mjs [--target PATH] [--url MCP_URL] [--uninstall]");
  }
  console.log(JSON.stringify(await install(options)));
}

if (isMain(import.meta.url)) runCli().catch((error) => { console.error(error.message); process.exitCode = 1; });

