import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The portable helper is plain ESM.
import { validateProgressInput } from "../skills/wondertoken/scripts/progress-validation.mjs";
// @ts-expect-error The portable helper is plain ESM.
import { compactResult, compactTool, schemaHasProperty, withoutManagedSchemaFields, toolTimeoutMs } from "../skills/wondertoken/scripts/client.mjs";
// @ts-expect-error The portable helper is plain ESM.
import { compactSoulPreparation, initializeCompletion, execute, prepareCompletion, isSoulSubmissionResult, progressDraft } from "../skills/wondertoken/scripts/progress-workflow.mjs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const place = (placeId: string, city: string) => ({
  provider: "amap", placeId, name: city, address: "测试地址", district: "测试区", city,
  province: "西藏自治区", adcode: "540102", longitude: 91.17, latitude: 29.65,
});

test("union schemas retain return inputs while recursively hiding managed identity", () => {
  const schema = {
    oneOf: [
      { type: "object", properties: { playerKey: { type: "string" }, type: { const: "visit" }, destination: { type: "object" } }, required: ["playerKey", "type", "destination"] },
      { type: "object", properties: { playerKey: { type: "string" }, type: { const: "return" }, estimatedVirtualDays: { type: "number" } }, required: ["playerKey", "type", "estimatedVirtualDays"] },
    ],
  };
  assert.equal(schemaHasProperty(schema, "playerKey"), true);
  const compact = compactTool({ name: "add_journey_directive", title: "影响后续旅程", description: "", inputSchema: schema });
  assert.equal(compact.variants.length, 2);
  assert.equal(compact.variants[1].input.estimatedVirtualDays.required, true);
  assert.equal(Object.hasOwn(compact.variants[1].input, "playerKey"), false);
  assert.equal(JSON.stringify(withoutManagedSchemaFields(schema)).includes("playerKey"), false);
});

test("preflight reports every invalid stay and the total without changing the payload", () => {
  const context = { window: { fromVirtualDay: 0, toVirtualDay: 10 }, currentLocation: { placeId: "home" } };
  const input = { movements: [
    { destination: place("lhasa", "拉萨市"), departedVirtualDay: 0, arrivedVirtualDay: 2, transportMode: "火车", travelTimeReasoning: "长途火车包含候车和抵达后的安排。", landmarkNames: ["布达拉宫"] },
    { destination: place("home", "北京市"), departedVirtualDay: 8, arrivedVirtualDay: 10, transportMode: "火车", travelTimeReasoning: "留出返程和进站时间后回到家园。", landmarkNames: [] },
  ], expenses: [
    { category: "lodging", description: "住宿", placeId: "lhasa", fromVirtualDay: 1, toVirtualDay: 2, amount: "180" },
    { category: "food", description: "餐食", placeId: "lhasa", fromVirtualDay: 8, toVirtualDay: 9, amount: "60" },
    { category: "transport", description: "车票", placeId: "lhasa", fromVirtualDay: 0, toVirtualDay: 2, amount: "900", transportMode: "火车" },
  ], activities: [], finalize: true, expenseTotal: "0", returnExpenseEstimate: "0" };
  const before = JSON.stringify(input);
  const errors = validateProgressInput("lock_journey_progress_facts", input, context);
  assert.deepEqual(errors.map((error: { path: string }) => error.path), ["expenses[0]", "expenses[1]", "expenseTotal"]);
  assert.match(errors[0].message, /"from":2,"to":8/);
  assert.equal(JSON.stringify(input), before);
  input.expenses[0]!.fromVirtualDay = 2;
  input.expenses[0]!.toVirtualDay = 3;
  input.expenses[1]!.fromVirtualDay = 7;
  input.expenses[1]!.toVirtualDay = 8;
  input.expenseTotal = "1140";
  assert.deepEqual(validateProgressInput("lock_journey_progress_facts", input, context), []);
});

test("preflight catches length, paragraphs and classic scene requirements together", () => {
  const context = { data: { facts: { finalize: true }, submissionRequirements: { imageBrief: {
    required: true, sceneMoment: "turning-point", actionMustInclude: ["十八", "豆包"],
    focalLandmarks: ["布达拉宫"], allowedLandmarks: ["布达拉宫"],
  } } } };
  const input: { content: string; imageBrief: Record<string, unknown> } = { content: "旅".repeat(551), imageBrief: { sceneMoment: "homecoming", action: "十八回到家", focalLandmark: "布达拉宫" } };
  const errors = validateProgressInput("submit_journey_progress", input, context);
  assert.equal(errors.length, 9);
  input.content = ["旅".repeat(165), "途".repeat(165), "归".repeat(165)].join("\n\n");
  input.imageBrief.sceneMoment = "turning-point";
  input.imageBrief.action = "十八与豆包一起挥手告别";
  input.imageBrief.narrativeCue = "他们把高原晚风收进背包";
  input.imageBrief.timeOfDay = "sunset";
  input.imageBrief.weather = "clear";
  input.imageBrief.mood = "warm";
  input.imageBrief.camera = { shot: "wide", angle: "eye-level", composition: "leading-lines" };
  assert.deepEqual(validateProgressInput("submit_journey_progress", input, context), []);
});

test("preflight rejects offline place references and invalid activities before a network request", () => {
  const context = { window: { fromVirtualDay: 0, toVirtualDay: 2 }, currentLocation: { placeId: "home" } };
  const input = {
    movements: [{ destination: { placeId: "city", placeRef: "offline-city" }, departedVirtualDay: 0, arrivedVirtualDay: 1 }],
    activities: [{ category: "culture", tags: ["museum"], placeId: "unknown", placeRef: "offline-city" }],
    expenses: [{ category: "food", placeId: "city", placeRef: "offline-city", fromVirtualDay: 1, toVirtualDay: 2, amount: "1" }],
    expenseTotal: "1",
  };
  const paths = validateProgressInput("lock_journey_progress_facts", input, context).map((error: { path: string }) => error.path);
  assert.ok(paths.includes("movements[0].destination.placeRef"));
  assert.ok(paths.includes("expenses[0].placeRef"));
  assert.ok(paths.includes("activities[0].placeRef"));
});

test("completion only accepts a submitted Soul result for the matching journey", () => {
  const preparedSoul = { data: { journeyId: "journey", expectedRevision: 0, soul: { settledMood: "安稳" } } };
  assert.equal(isSoulSubmissionResult(preparedSoul, "journey"), false);
  assert.equal(isSoulSubmissionResult({ data: { journeyId: "other", status: "submitted", soul: { revision: 1 } } }, "journey"), false);
  assert.equal(isSoulSubmissionResult({ data: { journeyId: "journey", status: "submitted", soul: { revision: 1 } } }, "journey"), true);
});

test("draft exposes the prepared constraints without inventing travel facts", () => {
  const draft = progressDraft({ data: {
    window: { fromVirtualDay: 0, toVirtualDay: 2, automaticHomecoming: false },
    progressConstraints: { maximumMovements: 20, maximumCities: 5, amountEncoding: "decimal-string" },
    routePlan: { days: [{ day: 1, stops: ["拉萨"] }, { day: 3, stops: ["未来站"] }] },
  } });
  assert.deepEqual(draft.facts, { movements: [], activities: [], expenses: [], expenseTotal: "0", returnExpenseEstimate: "0", finalize: false });
  assert.equal(draft.guidance.constraints.maximumMovements, 20);
  assert.deepEqual(draft.guidance.routeDays, [{ day: 1, stops: ["拉萨"] }]);
});

test("compact progress results keep decision inputs and omit duplicate diary prose", () => {
  const prepared = compactResult("prepare_journey_progress", {
    schemaVersion: "interaction-v2",
    data: {
      phase: "prepared",
      progressHandle: { queryId: "query", revision: 2 },
      window: { fromVirtualDay: 1, toVirtualDay: 2 },
      continuity: { petMood: "好奇" },
      routePlan: { id: "route", title: "十日路线", travelMode: "self-drive", days: [
        { day: 1, stops: ["旧站"] }, { day: 2, stops: ["当前站"] }, { day: 3, stops: ["未来站"] },
      ] },
      recentProgress: [
        { id: "older", sequence: 0, content: "更早的旧来信", continuity: { petMood: "期待" } },
        { id: "old", sequence: 1, content: "不应重复放入上下文的旧来信", continuity: { petMood: "安静" } },
      ],
      internalOnly: { veryLarge: true },
    },
  });
  assert.deepEqual(prepared, {
    schemaVersion: "interaction-v2",
    data: {
      phase: "prepared",
      progressHandle: { queryId: "query", revision: 2 },
      window: { fromVirtualDay: 1, toVirtualDay: 2 },
      continuity: { petMood: "好奇" },
      routePlan: { id: "route", title: "十日路线", travelMode: "self-drive", days: [{ day: 2, stops: ["当前站"] }] },
      recentProgress: [{ id: "old", sequence: 1, continuity: { petMood: "安静" } }],
    },
  });

  const locked = compactResult("lock_journey_progress_facts", { data: {
    phase: "locked", progressHandle: { queryId: "query", revision: 3 },
    window: { fromAt: "large timestamp", toAt: "another timestamp", fromVirtualDay: 1, toVirtualDay: 2,
      automaticHomecoming: true, completionTrigger: "planned-homecoming", hardCapReached: false },
    facts: { finalize: true }, submissionRequirements: { content: { minimumCharacters: 450 } },
  } });
  assert.deepEqual(locked.data.window, { fromVirtualDay: 1, toVirtualDay: 2,
    automaticHomecoming: true, completionTrigger: "planned-homecoming" });

  const submitted = compactResult("submit_journey_progress", {
    data: {
      status: "completed",
      entry: { id: "entry", sequence: 2, content: "已经由本地 letter.json 保存的正文" },
      stateAfter: { balance: "10" },
      settlement: { unlockedAchievements: [] },
    },
  });
  assert.deepEqual(submitted, {
    data: {
      status: "completed",
      entry: { id: "entry", sequence: 2 },
      stateAfter: { balance: "10" },
      settlement: { unlockedAchievements: [] },
    },
  });
});

test("Soul completion context keeps evidence but omits archived prose, costs and image briefs", () => {
  const compact = compactSoulPreparation({ data: {
    journeyId: "journey", expectedRevision: 2, soul: { settledMood: "平静" }, memories: [], directives: [],
    progress: [{ id: "entry", sequence: 1, fromVirtualDay: 0, toVirtualDay: 2, content: "完整旅行来信",
      continuity: { petMood: "好奇" }, movements: [{ destination: { city: "拉萨" } }], activities: [], localNews: [],
      expenses: [{ amount: "100" }], balanceAfter: "900", imageBrief: { narrativeCue: "不应进入 Soul 上下文" }, final: true }],
  } });
  assert.deepEqual(compact.data.progress[0], {
    id: "entry", sequence: 1, fromVirtualDay: 0, toVirtualDay: 2, continuity: { petMood: "好奇" },
    movements: [{ destination: { city: "拉萨" } }], activities: [], localNews: [], final: true,
  });
});

test("completion checkpoint persists before slow jobs start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wondertoken-completion-"));
  const output = join(directory, "completion.json");
  const state = await initializeCompletion({ data: {
    status: "completed",
    stateAfter: { journeyId: "journey" },
    nextActions: { soulEvolution: "required", memoryImage: "ready", traceSharing: "wait-for-image" },
  } }, output);
  assert.deepEqual(state, {
    version: 2,
    journeyId: "journey",
    settlement: "completed",
    nextActions: { soulEvolution: "required", memoryImage: "ready", traceSharing: "wait-for-image" },
    soul: { status: "pending" },
    image: { status: "pending" },
  });
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), state);
});


test("homecoming submission generates its image before returning, and replay retains completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wondertoken-inline-completion-"));
  const output = join(directory, "nested", "submitted.json");
  const submission = { data: { status: "completed", stateAfter: { journeyId: "journey" },
    nextActions: { soulEvolution: "required", memoryImage: "ready" } } };
  const calls: string[] = [];
  const runner = async (work: (session: unknown) => Promise<unknown>) => work({
    async callTool(name: string) {
      // Settlement must already be durable before either slow request starts.
      assert.deepEqual(JSON.parse(await readFile(output, "utf8")), submission);
      calls.push(name);
      return { data: name === "generate_memory_image" ? { memoryImageUrl: "https://example.test/memory.png", mediaGrowthDelta: { achievementXp: 2 }, mediaUnlockedAchievements: [{ code: "first-memory-image" }] }
        : { journeyId: "journey", expectedRevision: 0, progress: [] } };
    },
  });
  const options = { tool: "submit_journey_progress", request: { operationId: "operation" }, output, reuseOperation: true };
  const dependencies = { call: async () => submission,
    prepare: (state: unknown, path: string) => prepareCompletion(state, path, { emit: false, sessionRunner: runner }) };
  await execute(options, dependencies);
  const state = JSON.parse(await readFile(`${output}.completion.json`, "utf8"));
  assert.equal(state.soul.status, "prepared");
  assert.equal(state.image.status, "succeeded");
  assert.equal(state.image.rewards.growthDelta.achievementXp, 2);
  assert.equal(state.image.rewards.unlockedAchievements[0].code, "first-memory-image");
  assert.deepEqual(calls.sort(), ["generate_memory_image", "get_memory_image", "prepare_pet_soul_evolution"]);
  await execute(options, dependencies);
  assert.equal(calls.length, 3, "replayed submission must not regenerate the image or reread prepared Soul");
});

test("completion jobs start together and image failure preserves prepared Soul for recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wondertoken-completion-retry-"));
  const output = join(directory, "completion.json");
  const state = await initializeCompletion({ data: { status: "completed", stateAfter: { journeyId: "journey" },
    nextActions: { soulEvolution: "required", memoryImage: "ready" } } }, output);
  let releaseSoul!: () => void;
  const imageStarted = new Promise<void>((resolve) => { releaseSoul = resolve; });
  const operations: string[] = [];
  const failed = await prepareCompletion(state, output, { emit: false,
    sessionRunner: async (work: (session: unknown) => Promise<unknown>) => work({
      async callTool(name: string, args: { operationId: string }) {
        if (name === "prepare_pet_soul_evolution") { await imageStarted; return { data: { progress: [] } }; }
        operations.push(args.operationId); releaseSoul(); throw new Error("network interrupted");
      },
    }),
  });
  assert.equal(failed.soul.status, "prepared");
  assert.equal(failed.image.status, "pending");
  assert.equal(failed.settlement, "completed");
  const recovered = await prepareCompletion(failed, output, { emit: false,
    sessionRunner: async (work: (session: unknown) => Promise<unknown>) => work({
      async callTool(name: string, args: { operationId: string }) {
        if (name === "get_memory_image") return { attachments: [{ path: "/tmp/memory.png", mimeType: "image/png" }] };
        assert.equal(name, "generate_memory_image"); operations.push(args.operationId);
        return { data: { memoryImageUrl: "https://example.test/memory.png" } };
      },
    }),
  });
  assert.equal(recovered.image.status, "succeeded");
  assert.equal(operations[0], operations[1], "uncertain image retry uses the same operation");
  assert.equal(toolTimeoutMs("generate_memory_image"), 180_000);
  assert.equal(toolTimeoutMs("get_game_state"), 30_000);
});

test("city stay preflight uses prior windows and keeps policy in compact output", () => {
  const current = place("lhasa", "拉萨市");
  const context = { window: { fromVirtualDay: 9, toVirtualDay: 12 }, currentLocation: current,
    routePolicy: { homePlaceId: "home", currentCity: current, visitedCities: ["拉萨市"],
      cityStayDays: { "西藏自治区/拉萨市": 8 } }, progressConstraints: { maximumCityStayDays: 10 } };
  const input = { movements: [], activities: [], expenses: [], expenseTotal: "0", returnExpenseEstimate: "0", finalize: false };
  const errors = validateProgressInput("lock_journey_progress_facts", input, context);
  assert.ok(errors.some((error: { message: string }) => /cumulative stay 11 exceeds 10/.test(error.message)));
  assert.deepEqual(compactResult("prepare_journey_progress", { data: context }).data.routePolicy, context.routePolicy);
  context.window.toVirtualDay = 11;
  assert.deepEqual(validateProgressInput("lock_journey_progress_facts", input, context), []);
});
