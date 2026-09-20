#!/usr/bin/env node
import { isMain } from "./local.mjs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { cli, connectionConfig, ensureStateDirectory, localConnection, protect, readJson, stateRoot } from "./local.mjs";
import { ensureIdentity } from "./identity.mjs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { validateProgressInput } from "./progress-validation.mjs";

const { version: clientVersion } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const TOOL_CACHE_VERSION = 1;
const TOOL_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const CLIENT_USAGE = "client.mjs tools [--compact] [TOOL...] | call/validate TOOL [--input input.json | --json JSON] [--context context.json] [--output result.json] [--compact]";
export async function saveImageAttachments(result, directory = join(stateRoot, "media")) {
  const images = (result.content ?? []).filter((item) => item.type === "image");
  if (!images.length || result.isError) return result.structuredContent ?? result;
  const output = structuredClone(result.structuredContent ?? {});
  const attachments = [];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await protect(directory, true);
  for (const item of images) {
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[item.mimeType];
    if (!extension || typeof item.data !== "string" || item.data.length > 40_000_000) throw new Error("INVALID_IMAGE_ATTACHMENT");
    const bytes = Buffer.from(item.data, "base64");
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    const path = resolve(directory, `${fingerprint}.${extension}`);
    await writeFile(path, bytes, { mode: 0o600 });
    await protect(path);
    attachments.push({ path, mimeType: item.mimeType });
  }
  return { ...output, attachments };
}
export function toolTimeoutMs(name) { return name === "start_journey" ? 600_000 : name === "generate_memory_image" ? 180_000 : 30_000; }

function requestTimeoutMs(init) {
  try {
    const body = JSON.parse(init?.body);
    return toolTimeoutMs(body?.method === "tools/call" ? body.params?.name : undefined);
  } catch { return toolTimeoutMs(); }
}

function toolCachePath(mcpUrl) {
  const key = createHash("sha256").update(mcpUrl).digest("hex").slice(0, 16);
  return join(stateRoot, `tool-schema-${key}.json`);
}

async function readCachedTools(mcpUrl) {
  let cached;
  try { cached = await readJson(toolCachePath(mcpUrl)); }
  catch (error) { if (error?.name !== "SyntaxError") throw error; return null; }
  if (cached?.version !== TOOL_CACHE_VERSION || cached?.mcpUrl !== mcpUrl || !Array.isArray(cached?.tools)) return null;
  const cachedAt = Date.parse(cached.cachedAt);
  return Number.isFinite(cachedAt) && Date.now() - cachedAt <= TOOL_CACHE_MAX_AGE_MS ? cached.tools : null;
}

async function writeCachedTools(mcpUrl, tools) {
  await ensureStateDirectory();
  const path = toolCachePath(mcpUrl);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: TOOL_CACHE_VERSION, mcpUrl, cachedAt: new Date().toISOString(), tools })}\n`, { mode: 0o600 });
  await protect(temporary);
  await rename(temporary, path);
  await protect(path);
}

async function listAllTools(client) {
  const tools = []; let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools); cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export async function withClient(work, { mcpUrl } = {}) {
  const selected = await connectionConfig(mcpUrl);
  const client = new Client({ name: "wondertoken-portable", version: clientVersion });
  const transport = new StreamableHTTPClientTransport(new URL(selected.mcpUrl), {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(requestTimeoutMs(init)),
    ]) }),
  });
  try { await client.connect(transport); return await work(client); }
  finally { await client.close(); }
}
export async function withToolSession(work, { mcpUrl } = {}) {
  return withClient(async (client) => {
    const selected = await connectionConfig(mcpUrl);
    let tools = await readCachedTools(selected.mcpUrl);
    async function refreshTools() {
      tools = await listAllTools(client);
      // An optional cache must not turn an otherwise permitted game operation
      // into a request for filesystem escalation.
      try { await writeCachedTools(selected.mcpUrl, tools); }
      catch (error) { if (!["EACCES", "EPERM", "EROFS"].includes(error?.code)) throw error; }
      return tools;
    }
    if (!tools) await refreshTools();
    return work({
      async callTool(name, args = {}, { context } = {}) {
        if (Object.hasOwn(args, "playerKey")) throw new Error("PLAYER_KEY_IS_MANAGED_LOCALLY");
        const errors = validateProgressInput(name, args, context);
        if (errors.length) return { error: { code: "LOCAL_VALIDATION_FAILED", sent: false, errors } };
        let tool = tools.find((item) => item.name === name);
        if (!tool) {
          await refreshTools();
          tool = tools.find((item) => item.name === name);
        }
        if (!tool) throw new Error("WONDERTOKEN_TOOL_NOT_FOUND");
        const input = { ...args };
        if (schemaHasProperty(tool.inputSchema, "playerKey")) {
          await ensureIdentity();
          input.playerKey = (await localConnection()).playerKey;
        }
        const result = await client.callTool({ name, arguments: input }, { timeout: toolTimeoutMs(name) });
        const output = await saveImageAttachments(result);
        return JSON.parse(JSON.stringify(output).replaceAll(input.playerKey ?? "\u0000", "[redacted]"));
      },
      tools,
    });
  }, { mcpUrl });
}

export async function callTool(name, args = {}, { context } = {}) {
  // Identity never has to be pasted into shell arguments or supplied by an LLM.
  return withToolSession((session) => session.callTool(name, args, { context }));
}

function dataOf(result) {
  return result?.data ?? result;
}

/** Resolve the small JSON-schema subset returned by MCP without making callers
 * learn whether Zod emitted an object, a union, or a reference. */
function dereference(schema, root) {
  if (!schema?.$ref || typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/$defs/")) return schema;
  return root?.$defs?.[schema.$ref.slice("#/$defs/".length)] ?? schema;
}

export function schemaHasProperty(schema, property, root = schema, seen = new Set()) {
  schema = dereference(schema, root);
  if (!schema || typeof schema !== "object" || seen.has(schema)) return false;
  seen.add(schema);
  if (Object.hasOwn(schema.properties ?? {}, property)) return true;
  return ["allOf", "anyOf", "oneOf"].some((key) =>
    Array.isArray(schema[key]) && schema[key].some((child) => schemaHasProperty(child, property, root, seen)));
}

export function withoutManagedSchemaFields(schema, root = schema, seen = new Map()) {
  schema = dereference(schema, root);
  if (!schema || typeof schema !== "object") return schema;
  if (seen.has(schema)) return seen.get(schema);
  if (Array.isArray(schema)) return schema.map((item) => withoutManagedSchemaFields(item, root, seen));
  const copy = {};
  seen.set(schema, copy);
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object") {
      copy.properties = Object.fromEntries(Object.entries(value)
        .filter(([name]) => name !== "playerKey")
        .map(([name, child]) => [name, withoutManagedSchemaFields(child, root, seen)]));
    } else if (key === "required" && Array.isArray(value)) {
      copy.required = value.filter((name) => name !== "playerKey");
    } else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(value)) {
      copy[key] = value.map((child) => withoutManagedSchemaFields(child, root, seen));
    } else if (key !== "$defs") {
      copy[key] = value;
    }
  }
  return copy;
}

function compactSchema(schema, root = schema) {
  schema = dereference(schema, root);
  if (!schema || typeof schema !== "object") return {};
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const input = Object.fromEntries(Object.entries(properties)
    .filter(([name]) => name !== "playerKey")
    .map(([name, property]) => {
      const resolved = dereference(property, root) ?? {};
      return [name, {
        required: required.has(name), type: resolved.type,
        format: resolved.format, enum: resolved.enum,
        ...(resolved.anyOf || resolved.oneOf ? { variants: compactSchema(resolved, root).variants } : {}),
      }];
    }));
  const alternatives = schema.oneOf ?? schema.anyOf;
  return {
    ...(Object.keys(input).length ? { input } : {}),
    ...(Array.isArray(alternatives) ? { variants: alternatives.map((item) => compactSchema(item, root)) } : {}),
  };
}

function progressEntrySummary(entry) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    ...(entry.id ? { id: entry.id } : {}),
    ...(entry.sequence === undefined ? {} : { sequence: entry.sequence }),
    ...(entry.fromVirtualDay === undefined ? {} : { fromVirtualDay: entry.fromVirtualDay }),
    ...(entry.toVirtualDay === undefined ? {} : { toVirtualDay: entry.toVirtualDay }),
    ...(entry.continuity ? { continuity: entry.continuity } : {}),
    ...(entry.localNews ? { localNews: entry.localNews } : {}),
  };
}

/**
 * Keep the fields an agent needs for the next decision, without printing a
 * duplicate archive, prose body, or full previous diary on every CLI call.
 * The unmodified server response is still written to --output for recovery.
 */
export function compactResult(name, result) {
  if (result?.error || result?.isError) return result;
  const data = dataOf(result);
  if (!data || typeof data !== "object" || Array.isArray(data)) return result;
  if (name === "prepare_journey_progress") {
    const keys = [
      "progressAvailable", "reason", "journey", "elapsedTravelDays", "community",
      "localNewsContext", "currentLocation", "balance", "returnExpenseEstimate",
      "phase", "progressHandle", "window", "continuity", "anchorDestination",
      "progressConstraints", "routePolicy",
      "routePlan", "directives", "soulContext", "lockedFacts", "submissionRequirements",
      "soulRecallCandidates", "session", "status", "next", "lastProgress",
    ];
    const compact = Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
    if (data.routePlan?.days && data.window) {
      compact.routePlan = { id: data.routePlan.id, title: data.routePlan.title, travelMode: data.routePlan.travelMode,
        days: data.routePlan.days.filter((day) => day.day > data.window.fromVirtualDay && day.day <= Math.ceil(data.window.toVirtualDay)) };
    }
    if (data.recentProgress) compact.recentProgress = data.recentProgress.slice(-1).map(progressEntrySummary);
    return { ...(result?.schemaVersion ? { schemaVersion: result.schemaVersion } : {}), data: compact };
  }
  if (name === "lock_journey_progress_facts") {
    const keys = ["phase", "progressHandle", "window", "facts", "submissionRequirements", "soulRecallCandidates", "session"];
    const compact = Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
    if (data.window) compact.window = {
      fromVirtualDay: data.window.fromVirtualDay,
      toVirtualDay: data.window.toVirtualDay,
      automaticHomecoming: data.window.automaticHomecoming,
      ...(data.window.completionTrigger ? { completionTrigger: data.window.completionTrigger } : {}),
    };
    return { ...(result?.schemaVersion ? { schemaVersion: result.schemaVersion } : {}), data: compact };
  }
  if (name === "submit_journey_progress") {
    return { ...(result?.schemaVersion ? { schemaVersion: result.schemaVersion } : {}), data: {
      ...(data.status ? { status: data.status } : {}),
      ...(data.session ? { session: data.session } : {}),
      ...(data.entry ? { entry: progressEntrySummary(data.entry) } : {}),
      ...(data.stateAfter ? { stateAfter: data.stateAfter } : {}),
      ...(data.settlement ? { settlement: data.settlement } : {}),
      ...(data.nextActions ? { nextActions: data.nextActions } : {}),
    } };
  }
  return result;
}

export function compactTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    ...compactSchema(tool.inputSchema),
  };
}
export async function runCli() {
  await cli(async () => {
    const command = process.argv[2];
    if ([undefined, "help", "--help", "-h"].includes(command)) {
      console.log(JSON.stringify({ usage: CLIENT_USAGE, examples: [
        "client.mjs call get_game_state",
        "client.mjs call get_pet_soul",
        "client.mjs call get_pet_soul --input soul-query.json",
        "client.mjs tools --compact manage_pet_soul",
      ], note: "无参数工具可直接调用；有参数时优先使用 --input JSON 文件。--json 仅用于兼容短小的内联 JSON。" }));
      return;
    }
    if (command === "tools") {
      const tools = await withClient(async (client) => {
        const all = []; let cursor;
        do { const page = await client.listTools(cursor ? { cursor } : undefined); all.push(...page.tools); cursor = page.nextCursor; } while (cursor);
        return all;
      });
      // Expose the caller's schema: credentials are injected only inside callTool.
      const publicTools = tools.map((tool) => ({ ...tool, inputSchema: withoutManagedSchemaFields(tool.inputSchema) }));
      const args = process.argv.slice(3);
      const compact = args.includes("--compact");
      const names = args.filter((arg) => arg !== "--compact");
      const selected = names.length ? publicTools.filter((tool) => names.includes(tool.name)) : publicTools;
      console.log(JSON.stringify({ tools: compact ? selected.map(compactTool) : selected })); return;
    }
    if (!["call", "validate"].includes(command) || !process.argv[3]) throw new Error(`USAGE: ${CLIENT_USAGE}`);
    const options = {};
    for (let index = 4; index < process.argv.length;) {
      const flag = process.argv[index];
      if (flag === "--compact" && !options[flag]) { options[flag] = true; index += 1; continue; }
      if (!["--input", "--json", "--context", "--output"].includes(flag) || !process.argv[index + 1] || options[flag]
        || (flag === "--json" && options["--input"]) || (flag === "--input" && options["--json"])) {
        throw new Error(`INVALID_CLIENT_OPTION; USAGE: ${CLIENT_USAGE}`);
      }
      options[flag] = process.argv[index + 1];
      index += 2;
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of options["--json"] ? [Buffer.from(options["--json"], "utf8")]
      : options["--input"] ? [await readFile(options["--input"])] : process.stdin) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("INPUT_TOO_LARGE");
      chunks.push(chunk);
    }
    const rawInput = Buffer.concat(chunks).toString("utf8");
    if ((options["--input"] || options["--json"]) && !rawInput.trim()) throw new Error("EMPTY_JSON_INPUT; omit --input for an empty object, or provide a valid JSON file");
    let args;
    try { args = rawInput.trim() ? JSON.parse(rawInput) : {}; }
    catch { throw new Error("INVALID_JSON_INPUT; use a JSON file with --input, or valid JSON with --json"); }
    const context = options["--context"] ? JSON.parse(await readFile(options["--context"], "utf8")) : undefined;
    const errors = validateProgressInput(process.argv[3], args, context);
    const result = command === "validate" || errors.length
      ? errors.length ? { error: { code: "LOCAL_VALIDATION_FAILED", sent: false, errors } } : { valid: true, sent: false }
      : await callTool(process.argv[3], args, { context });
    if (options["--output"]) await writeFile(options["--output"], JSON.stringify(result), { mode: 0o600 });
    console.log(JSON.stringify(options["--compact"] ? compactResult(process.argv[3], result) : result));
    if (result.error || result.isError) process.exitCode = 1;
  });
}
if (isMain(import.meta.url)) await runCli();
