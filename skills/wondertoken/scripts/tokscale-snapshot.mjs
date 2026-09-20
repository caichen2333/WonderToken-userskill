#!/usr/bin/env node
import { isMain, protect } from "./local.mjs";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { executable, npmCommand, run } from "./runtime.mjs";
import { cli } from "./local.mjs";

export const TOKSCALE_VERSION = "4.14.0";
const fields = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
export function snapshotHash(snapshot) {
  const canonical = {
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
    tokscaleVersion: snapshot.tokscaleVersion,
    generatedAt: snapshot.generatedAt,
    clients: [...snapshot.clients]
      .sort((a, b) => a.client < b.client ? -1 : a.client > b.client ? 1 : 0)
      .map(({ client, totals }) => ({ client, totals: Object.fromEntries(fields.map((key) => [key, totals[key]])) })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
export function normalizeTokscale(payload, generatedAt = new Date().toISOString()) {
  if (!Array.isArray(payload?.entries)) throw new Error("TOKSCALE_ENTRIES_MISSING");
  const clients = new Map();
  for (const entry of payload.entries) {
    if (typeof entry?.client !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.client)) throw new Error("TOKSCALE_INVALID_CLIENT");
    const totals = clients.get(entry.client) ?? Object.fromEntries(fields.map((key) => [key, 0n]));
    for (const key of fields) {
      const value = entry[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`TOKSCALE_UNSAFE_${key}`);
      totals[key] += BigInt(value);
    }
    clients.set(entry.client, totals);
  }
  if (!clients.size) throw new Error("NO_USAGE_FOUND");
  if (clients.size > 128) throw new Error("TOKSCALE_TOO_MANY_CLIENTS");
  const base = {
    schemaVersion: 2, source: "tokscale", tokscaleVersion: TOKSCALE_VERSION, generatedAt,
    clients: [...clients].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([client, totals]) => ({
      client, totals: Object.fromEntries(fields.map((key) => [key, totals[key].toString()])),
    })),
  };
  return { ...base, snapshotHash: snapshotHash(base) };
}
export async function chooseRunner() {
  const override = process.env.WONDERTOKEN_TOKSCALE_COMMAND;
  const global = override ?? await executable("tokscale");
  if (global && !/\.(cmd|bat)$/i.test(global)) {
    const command = global.endsWith(".mjs") || global.endsWith(".js") ? process.execPath : global;
    const prefix = command === process.execPath ? [global] : [];
    try {
      const version = (await run(command, [...prefix, "--version"], { timeout: 10_000 })).trim();
      if (new RegExp(`(^|\\s)v?${TOKSCALE_VERSION.replaceAll(".", "\\.")}($|\\s)`).test(version)) {
        return { kind: "tokscale", command, prefix, downloadMayBeRequired: false };
      }
    } catch {}
    if (override) throw new Error("TOKSCALE_VERSION_MISMATCH");
  }
  try {
    const npm = await npmCommand("npx");
    return { kind: "npx", command: npm.command, prefix: [...npm.prefix, "--yes", `tokscale@${TOKSCALE_VERSION}`], downloadMayBeRequired: true };
  } catch { return null; }
}
export async function checkTokscale() {
  const runner = await chooseRunner();
  return { ready: Boolean(runner), runner: runner?.kind ?? null, tokscaleVersion: TOKSCALE_VERSION,
    downloadMayBeRequired: runner?.downloadMayBeRequired ?? false, runtimeInstallRequired: !runner, scope: "all-readable-clients" };
}

export async function collectTokscale({ allowDownload = false } = {}) {
  const runner = await chooseRunner();
  if (!runner) throw new Error("NPM_RUNTIME_MISSING");
  if (runner.downloadMayBeRequired && !allowDownload) throw new Error("TOKSCALE_DOWNLOAD_APPROVAL_REQUIRED");
  const stdout = await run(runner.command, [...runner.prefix, "models", "--json", "--group-by", "client,provider,model"]);
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw new Error("TOKSCALE_INVALID_JSON"); }
  const snapshot = normalizeTokscale(payload);
  return { snapshot, clientsFound: snapshot.clients.map(({ client }) => client), runner: runner.kind };
}

export async function collectAndSettle({ allowDownload = false, output } = {}) {
  if (!output) throw new Error("TOKSCALE_SETTLE_OUTPUT_REQUIRED");
  const { compactResult, withToolSession } = await import("./client.mjs");
  const collected = await collectTokscale({ allowDownload });
  const requestPath = `${output}.request.json`;
  await writeFile(requestPath, `${JSON.stringify({ snapshot: collected.snapshot })}\n`, { mode: 0o600 });
  await protect(requestPath);
  const settlement = await withToolSession((session) => session.callTool("settle_usage", { snapshot: collected.snapshot }));
  const saved = { ...collected, settlement };
  await writeFile(output, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  await protect(output);
  return { clientsFound: collected.clientsFound, runner: collected.runner, request: requestPath, output,
    settlement: compactResult("settle_usage", settlement), failed: Boolean(settlement?.error || settlement?.isError) };
}

export async function runCli() {
  await cli(async () => {
    const argv = process.argv.slice(2);
    const args = new Set(argv);
    if (args.has("--check")) { console.log(JSON.stringify(await checkTokscale())); return; }
    if (args.has("--settle")) {
      const outputIndex = argv.indexOf("--output");
      const result = await collectAndSettle({ allowDownload: args.has("--allow-download"),
        output: outputIndex >= 0 ? argv[outputIndex + 1] : undefined });
      console.log(JSON.stringify(result));
      if (result.failed) process.exitCode = 1;
      return;
    }
    if (!args.has("--collect")) throw new Error("USAGE: tokscale-snapshot.mjs --check|--collect [--allow-download] | --settle --output FILE [--allow-download]");
    console.log(JSON.stringify(await collectTokscale({ allowDownload: args.has("--allow-download") })));
  });
}
if (isMain(import.meta.url)) await runCli();
