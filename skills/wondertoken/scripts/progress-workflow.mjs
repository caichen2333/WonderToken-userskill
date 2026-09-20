#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { callTool, compactResult, withToolSession } from "./client.mjs";
import { inspectOfflineQueue, openOfflineDatabase, offlineStatus, syncOfflineEvents } from "./offline-travel.mjs";
import { cli, isMain, withStateLock } from "./local.mjs";
import { progressIntent, progressReview } from "./progress-intent.mjs";

function usage() {
  throw new Error("USAGE: progress-workflow.mjs query --source source.json --output prepared.json [--journey-id ID] | prepare --output prepared.json [--journey-id ID] | review --context context.json | draft --context prepared.json --output facts.json | lock --input facts.json --context prepared.json --output locked.json | submit --input letter.json --context locked.json --output submitted.json | completion-prepare --context submitted.json --output completion.json | completion-status --context completion.json --output status.json | completion-finish --context completion.json --output completion.json [--soul-result result.json] [--image-result result.json] [--image-outcome reason]");
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || options[flag]) usage();
    options[flag] = value;
  }
  return options;
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
function dataOf(result) { return result?.data ?? result; }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function stableOperationId(value) {
  const hex = createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export async function reconcileOfflineProgress() {
  const inspected = await inspectOfflineQueue();
  if (inspected.pendingCount === 0) return inspected;
  return withStateLock("offline", async () => {
    const db = await openOfflineDatabase();
    try {
      const before = offlineStatus(db);
      if (before.pendingCount > 0) await syncOfflineEvents(db, randomUUID(), true);
      const after = offlineStatus(db);
      return {
        pendingCount: after.pendingCount,
        rejectedCount: after.rejectedCount,
        ...(before.pendingCount > 0 ? { synced: after.pendingCount === 0 } : {}),
      };
    } finally { db.close(); }
  });
}

function requireHandle(context) {
  const handle = dataOf(context).progressHandle;
  if (!handle?.queryId || !Number.isInteger(handle.revision)) throw new Error("PROGRESS_CONTEXT_HANDLE_REQUIRED");
  return handle;
}

function withoutManagedFields(input) {
  const { operationId, queryId, revision, playerKey, ...rest } = input;
  return rest;
}

export function progressDraft(context) {
  const data = dataOf(context);
  const constraints = data.progressConstraints ?? {};
  const routeDays = (data.routePlan?.days ?? []).filter((day) =>
    day.day > (data.window?.fromVirtualDay ?? 0) && day.day <= Math.ceil(data.window?.toVirtualDay ?? 0));
  return {
    facts: { movements: [], activities: [], expenses: [], expenseTotal: "0", returnExpenseEstimate: "0",
      finalize: Boolean(data.window?.automaticHomecoming) },
    guidance: {
      window: data.window,
      routePolicy: data.routePolicy,
      constraints: {
        maximumMovements: constraints.maximumMovements ?? 5,
        maximumCities: constraints.maximumCities ?? 5,
        maximumCityStayDays: constraints.maximumCityStayDays ?? 10,
        amountEncoding: constraints.amountEncoding ?? "decimal-string",
      },
      movementFields: ["destination", "departedVirtualDay", "arrivedVirtualDay", "transportMode", "travelTimeReasoning", "landmarkNames"],
      destination: "Copy a complete Amap-confirmed place object from search_places; never invent a place ID.",
      timing: "Build movements and stays first. Non-transport expenses and activities must fit one actual stay.",
      routeDays,
    },
  };
}

export async function execute({ tool, request, context, output, meta, reuseOperation = false },
  { call = callTool, prepare = prepareCompletion } = {}) {
  const requestPath = `${output}.request.json`;
  let persisted;
  try { persisted = await readJson(requestPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (tool === "prepare_journey_progress") {
    // The same output path may be used for a later question. Only an uncertain
    // prepare (no successful response) reuses its receipt.
    try {
      const previous = await readJson(output);
      if (!previous.error && !previous.isError) reuseOperation = false;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  // A retry after an uncertain transport result must use the exact operation ID.
  if (reuseOperation && persisted) {
    const { operationId: _old, ...oldMeaning } = persisted;
    const { operationId: _new, ...newMeaning } = request;
    if (stableJson(oldMeaning) === stableJson(newMeaning)) request = persisted;
  }
  await writeJson(requestPath, request);
  const result = await call(tool, request, { context });
  await writeJson(output, result);
  const completion = tool === "submit_journey_progress" && dataOf(result)?.status === "completed"
    ? await initializeCompletion(result, `${output}.completion.json`)
    : undefined;
  console.log(JSON.stringify({ request: requestPath, ...(meta ? { meta } : {}), result: compactResult(tool, result),
    ...(completion ? { completion: completionView(completion), completionContext: `${output}.completion.json` } : {}) }));
  if (result.error || result.isError) process.exitCode = 1;
  // Persist and emit settlement before the slower jobs, but start them in this
  // same invocation so a successful homecoming cannot silently defer its image.
  if (completion) await prepare(completion, `${output}.completion.json`);
}

function completedSubmission(context) {
  const data = dataOf(context);
  if (data?.status !== "completed" || !data?.stateAfter?.journeyId) throw new Error("COMPLETED_SUBMISSION_REQUIRED");
  return data;
}

export function compactSoulPreparation(result) {
  if (!result || result.error || result.isError) return result;
  const data = dataOf(result);
  if (!data || typeof data !== "object") return result;
  const compact = {
    journeyId: data.journeyId,
    expectedRevision: data.expectedRevision,
    soul: data.soul,
    memories: data.memories,
    directives: data.directives,
    progress: (data.progress ?? []).map((entry) => ({
      id: entry.id, sequence: entry.sequence,
      fromVirtualDay: entry.fromVirtualDay, toVirtualDay: entry.toVirtualDay,
      continuity: entry.continuity, movements: entry.movements,
      activities: entry.activities, localNews: entry.localNews, final: entry.final,
    })),
  };
  return result.data ? { ...(result.schemaVersion ? { schemaVersion: result.schemaVersion } : {}), data: compact } : compact;
}

function completionView(state) {
  const pending = [
    ...(state.soul.status === "pending" || state.soul.status === "prepared" ? ["soul"] : []),
    ...(state.image.status === "pending" || state.image.status === "prepared" ? ["memoryImage"] : []),
  ];
  return { version: state.version, journeyId: state.journeyId, settlement: state.settlement,
    soul: { status: state.soul.status, ...(state.soul.context ? { context: state.soul.context } : {}) },
    image: { status: state.image.status, ...(state.image.context ? { context: state.image.context } : {}) },
    ...(state.image.rewards ? { mediaRewards: state.image.rewards } : {}),
    pending, complete: pending.length === 0 };
}

export async function initializeCompletion(submission, output) {
  const data = completedSubmission(submission);
  const next = data.nextActions ?? {};
  const journeyId = data.stateAfter.journeyId;
  try {
    const existing = await readJson(output);
    if (existing.journeyId === journeyId && existing.settlement === "completed") return existing;
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const state = {
    version: 2, journeyId, settlement: "completed", nextActions: next,
    ...(data.session ? { session: data.session } : {}),
    soul: next.soulEvolution === "required" ? { status: "pending" } : { status: "not-eligible" },
    image: next.memoryImage === "ready" ? { status: "pending" } : { status: "not-eligible" },
  };
  await writeJson(output, state);
  return state;
}

export async function prepareCompletion(context, output, { emit = true, sessionRunner = withToolSession } = {}) {
  const isState = context?.settlement === "completed" && context?.journeyId;
  const data = isState ? undefined : completedSubmission(context);
  const current = isState ? structuredClone(context) : await initializeCompletion(context, output);
  const nextActions = current.nextActions ?? data?.nextActions ?? {
    soulEvolution: current.soul.status === "not-eligible" ? "not-eligible" : "required",
    memoryImage: current.image.status === "not-eligible" ? "not-eligible" : "ready",
  };
  const journeyId = current.journeyId;
  const isolate = async (work) => {
    try { return await work(); }
    catch { return { error: { code: "COMPLETION_REQUEST_FAILED", retryable: true, recovery: "retry-same-operation" } }; }
  };
  const [soul, image] = await sessionRunner((session) => Promise.all([
    current.soul.status === "pending" && nextActions.soulEvolution === "required"
      ? isolate(() => session.callTool("prepare_pet_soul_evolution", { journeyId })) : Promise.resolve(undefined),
    current.image.status === "pending" && nextActions.memoryImage === "ready"
      ? isolate(async () => {
        const generated = await session.callTool("generate_memory_image", {
          operationId: stableOperationId({ purpose: "generate-memory-image", journeyId }), journeyId,
        });
        if (generated?.error || generated?.isError) return generated;
        const delivery = await isolate(() => session.callTool("get_memory_image", { journeyId }));
        return { ...generated, attachments: delivery.attachments ?? [],
          ...(delivery.error || delivery.isError ? { deliveryError: delivery.error ?? { code: "IMAGE_DELIVERY_FAILED" } } : {}) };
      }) : Promise.resolve(undefined),
  ]));
  const soulContext = `${output}.soul.json`;
  const imageContext = `${output}.image.json`;
  if (soul !== undefined) await writeJson(soulContext, compactSoulPreparation(soul));
  if (image !== undefined) await writeJson(imageContext, image);
  const imageData = image === undefined ? undefined : dataOf(image);
  const rewards = imageData?.mediaGrowthDelta ? { growthDelta: imageData.mediaGrowthDelta,
    unlockedAchievements: imageData.mediaUnlockedAchievements ?? [] } : undefined;
  const state = {
    ...current, version: 2,
    soul: soul === undefined ? current.soul
      : { status: soul?.error || soul?.isError ? "pending" : "prepared", context: soulContext },
    image: image === undefined ? current.image
      : { status: image?.error || image?.isError ? "pending" : "succeeded", context: imageContext, ...(rewards ? { rewards } : {}) },
  };
  await writeJson(output, state);
  if (emit) console.log(JSON.stringify({ result: completionView(state) }));
  return state;
}

export function isSoulSubmissionResult(result, journeyId) {
  const soul = dataOf(result);
  return Boolean(!result?.error && !result?.isError && soul?.status === "submitted" &&
    soul?.journeyId === journeyId && Number.isInteger(soul?.soul?.revision));
}

async function finishCompletion(state, options, output) {
  if (!state?.version || !state?.journeyId) throw new Error("COMPLETION_CONTEXT_REQUIRED");
  const next = structuredClone(state);
  if (options["--soul-result"]) {
    const result = await readJson(options["--soul-result"]);
    next.soul.status = isSoulSubmissionResult(result, next.journeyId) ? "succeeded" : "pending";
    next.soul.result = result;
  }
  if (options["--image-result"]) {
    const result = await readJson(options["--image-result"]);
    next.image.status = result?.error || result?.isError ? "pending" : "succeeded";
    next.image.result = result;
    const data = dataOf(result);
    if (data?.mediaGrowthDelta) next.image.rewards = { growthDelta: data.mediaGrowthDelta,
      unlockedAchievements: data.mediaUnlockedAchievements ?? [] };
  }
  if (options["--image-outcome"]) {
    if (!["unsupported", "unavailable", "generation-failed", "upload-failed"].includes(options["--image-outcome"])) throw new Error("INVALID_IMAGE_OUTCOME");
    const operationId = next.image.outcomeOperationId ?? stableOperationId({ purpose: "memory-image-outcome", journeyId: next.journeyId, reason: options["--image-outcome"] });
    next.image.outcomeOperationId = operationId;
    const result = await callTool("record_memory_image_outcome", { operationId, journeyId: next.journeyId, reason: options["--image-outcome"] });
    next.image.status = result?.error || result?.isError ? "pending" : "skipped";
    next.image.result = result;
  }
  await writeJson(output, next);
  console.log(JSON.stringify({ result: completionView(next) }));
}

export async function runProgressWorkflow(argv = process.argv.slice(2)) {
  const command = argv[0];
  const options = parseOptions(argv.slice(1));
  if (command === "review") {
    if (!options["--context"] || Object.keys(options).some((key) => key !== "--context")) usage();
    const context = await readJson(options["--context"]);
    const data = dataOf(context);
    console.log(JSON.stringify(progressReview(context, data.session?.next)));
    return;
  }
  if (!options["--output"]) usage();
  if (command === "draft") {
    if (!options["--context"] || Object.keys(options).some((key) => !["--context", "--output"].includes(key))) usage();
    const draft = progressDraft(await readJson(options["--context"]));
    await writeJson(options["--output"], draft.facts);
    await writeJson(`${options["--output"]}.guide.json`, draft.guidance);
    console.log(JSON.stringify({ facts: options["--output"], guide: `${options["--output"]}.guide.json`, guidance: draft.guidance }));
    return;
  }
  if (command === "completion-prepare") {
    if (!options["--context"] || Object.keys(options).some((key) => !["--context", "--output"].includes(key))) usage();
    return prepareCompletion(await readJson(options["--context"]), options["--output"]);
  }
  if (command === "completion-status") {
    if (!options["--context"] || Object.keys(options).some((key) => !["--context", "--output"].includes(key))) usage();
    const state = await readJson(options["--context"]); await writeJson(options["--output"], completionView(state));
    console.log(JSON.stringify({ result: completionView(state) })); return;
  }
  if (command === "completion-finish") {
    if (!options["--context"] || Object.keys(options).some((key) => !["--context", "--output", "--soul-result", "--image-result", "--image-outcome"].includes(key))) usage();
    return finishCompletion(await readJson(options["--context"]), options, options["--output"]);
  }
  if (command === "prepare" || command === "query") {
    if (Object.keys(options).some((key) => !["--output", "--journey-id", "--source"].includes(key))) usage();
    if (command === "query" && !options["--source"]) throw new Error("PROGRESS_SOURCE_REQUIRED");
    const source = options["--source"] ? await readJson(options["--source"]) : undefined;
    if (source && progressIntent(source) === "read-only") {
      // No prepare, offline replay or settlement when the latest request says read-only.
      return execute({ tool: "get_game_state", request: {}, output: options["--output"],
        meta: { intent: "read-only", next: "deliver" } });
    }
    const offline = await reconcileOfflineProgress();
    if (offline.rejectedCount > 0) throw new Error("OFFLINE_CONFLICT_REQUIRES_RESOLUTION");
    return execute({
      tool: "prepare_journey_progress",
      request: { operationId: randomUUID(), ...(options["--journey-id"] ? { journeyId: options["--journey-id"] } : {}),
        ...(source ? { requestSource: source } : {}) },
      output: options["--output"],
      meta: { offline, ...(source ? { source, intent: "progress" } : {}) },
      reuseOperation: true,
    });
  }
  if (!options["--input"] || !options["--context"] || !["lock", "submit"].includes(command)) usage();
  if (Object.keys(options).some((key) => !["--input", "--context", "--output"].includes(key))) usage();
  const context = await readJson(options["--context"]);
  const handle = requireHandle(context);
  const session = dataOf(context).session;
  if (session && (session.queryId !== handle.queryId || session.revision !== handle.revision)) {
    throw new Error("PROGRESS_SESSION_HANDLE_MISMATCH");
  }
  const review = session ? progressReview(context, command) : undefined;
  const input = withoutManagedFields(await readJson(options["--input"]));
  return execute({
    tool: command === "lock" ? "lock_journey_progress_facts" : "submit_journey_progress",
    request: { ...input, operationId: randomUUID(), queryId: handle.queryId, revision: handle.revision },
    context,
    ...(review ? { meta: { review } } : {}),
    output: options["--output"],
    reuseOperation: command !== "prepare",
  });
}

if (isMain(import.meta.url)) await cli(() => runProgressWorkflow());
