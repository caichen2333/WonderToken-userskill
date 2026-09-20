import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error Portable ESM helpers.
import { progressIntent, progressReview } from "../skills/wondertoken/scripts/progress-intent.mjs";
// @ts-expect-error Portable ESM helpers.
import { execute, runProgressWorkflow } from "../skills/wondertoken/scripts/progress-workflow.mjs";
// @ts-expect-error Portable ESM helpers.
import { inspectOfflineQueue, openOfflineDatabase } from "../skills/wondertoken/scripts/offline-travel.mjs";

test("progress wording routes normally while explicit restrictions override it", () => {
  for (const text of ["到哪儿了", "旅行怎么样了", "去了哪里", "看看二十四到哪儿了"]) {
    assert.equal(progressIntent({ kind: "user-progress", text }), "progress");
  }
  for (const text of ["只查当前位置", "到哪儿了，不结算", "不要生成新进展", "暂停旅行", "read only"]) {
    assert.equal(progressIntent({ kind: "user-progress", text }), "read-only");
  }
  assert.throws(() => progressIntent({ kind: "user-progress", text: "到哪儿了", authorized: true }), /INVALID_PROGRESS_SOURCE/);
  assert.throws(() => progressIntent({ kind: "user-progress", text: "" }), /INVALID_PROGRESS_SOURCE/);
});

test("review carries original source and distinguishes fact freezing from virtual settlement", () => {
  const source = { kind: "user-progress", text: "到哪儿了", messageRef: "actual-message-reference" };
  const session = { version: "progress-session-v1", journeyId: "journey", queryId: "query", revision: 0,
    next: "lock", outcome: "homecoming", scope: "current-journey-virtual-progress", source };
  const review = progressReview({ session }, "lock");
  assert.deepEqual(review.source, source);
  assert.equal(review.effects.chargesVirtualCoins, false);
  assert.equal(review.effects.completesJourney, false);
  assert.equal(review.businessConfirmationRequired, false);
  const submit = progressReview({ session: { ...session, next: "submit" } }, "submit");
  assert.equal(submit.effects.chargesVirtualCoins, true);
  assert.equal(submit.effects.completesJourney, true);
  assert.equal(submit.realPayment, false);
  assert.equal(submit.publishesTrace, false);
  assert.throws(() => progressReview({ session }, "submit"), /STAGE_MISMATCH/);
  assert.throws(() => progressReview({ session }, "start_journey"), /STAGE_MISMATCH/);
});

test("workflow rejects forged handles and unknown options before connecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "wondertoken-guard-"));
  const context = join(root, "context.json"), input = join(root, "input.json"), output = join(root, "output.json");
  await writeFile(context, JSON.stringify({ progressHandle: { queryId: "query", revision: 0 },
    session: { queryId: "another-query", revision: 0 } }));
  await writeFile(input, "{}");
  const args = ["lock", "--context", context, "--input", input, "--output", output];
  await assert.rejects(runProgressWorkflow(args), /HANDLE_MISMATCH/);
  await assert.rejects(runProgressWorkflow([...args, "--url", "https://untrusted.example"]), /USAGE/);
  await assert.rejects(runProgressWorkflow(["query", "--output", output]), /SOURCE_REQUIRED/);
});

test("empty offline inspection creates no global state and existing queues are read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "wondertoken-readonly-"));
  assert.deepEqual(await inspectOfflineQueue(root), { pendingCount: 0, rejectedCount: 0 });
  assert.deepEqual(await readdir(root), []);
  const db = await openOfflineDatabase(root); db.close();
  const before = await readFile(join(root, "offline.sqlite"));
  assert.deepEqual(await inspectOfflineQueue(root), { pendingCount: 0, rejectedCount: 0 });
  assert.deepEqual(await readFile(join(root, "offline.sqlite")), before);
});

test("uncertain prepare reuses its operation, later questions get a fresh window", async () => {
  const root = await mkdtemp(join(tmpdir(), "wondertoken-prepare-retry-"));
  const output = join(root, "prepared.json");
  const options = { tool: "prepare_journey_progress", request: { operationId: "first" }, output, reuseOperation: true };
  await assert.rejects(execute(options, { call: async () => { throw new Error("connection lost"); } }), /connection lost/);
  const operations: string[] = [];
  const call = async (_: string, request: { operationId: string }) => {
    operations.push(request.operationId); return { data: { progressAvailable: true } };
  };
  await execute({ ...options, request: { operationId: "retry" } }, { call });
  await execute({ ...options, request: { operationId: "next-question" } }, { call });
  assert.deepEqual(operations, ["first", "next-question"]);
});

test("read-only queue inspection includes uncheckpointed WAL events", async () => {
  const root = await mkdtemp(join(tmpdir(), "wondertoken-wal-read-"));
  const writer = new DatabaseSync(join(root, "offline.sqlite"));
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE offline_events(status TEXT); INSERT INTO offline_events VALUES ('pending'), ('pending'), ('rejected')");
    assert.deepEqual(await inspectOfflineQueue(root), { pendingCount: 2, rejectedCount: 1 });
  } finally { writer.close(); }
});
