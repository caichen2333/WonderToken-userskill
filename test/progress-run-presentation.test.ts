import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatTravelDays, pendingRunOutput, renderDelivery } from "../skills/wondertoken/scripts/progress-run.mjs";

test("pending output contains only the current request identity", () => {
  const pending = pendingRunOutput({ tool: "begin_journey_progress_run", operationId: "new-operation" });

  assert.equal(pending.data, null);
  assert.deepEqual(pending.pending, {
    tool: "begin_journey_progress_run",
    operationId: "new-operation",
  });
  assert.equal("journeyId" in pending, false);
});

test("a failed request clears stale output and a retry preserves the operation identity", async () => {
  const runner = new URL("../skills/wondertoken/scripts/progress-run.mjs", import.meta.url).href;
  const client = new URL("../skills/wondertoken/scripts/client.mjs", import.meta.url).href;
  const workflow = new URL("../skills/wondertoken/scripts/progress-workflow.mjs", import.meta.url).href;
  await promisify(execFile)(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const directory = await mkdtemp(join(tmpdir(), 'wondertoken-pending-test-'));
    const output = join(directory, 'progress.json');
    const context = join(directory, 'context.json');
    const calls = [];
    try {
      mock.module(${JSON.stringify(workflow)}, { namedExports: { reconcileOfflineProgress: async () => {
        throw new Error('UNEXPECTED_OFFLINE_RECONCILIATION');
      } } });
      await writeFile(output, JSON.stringify({ data: { journeyId: 'old-journey' } }));
      await writeFile(context, JSON.stringify({ data: { id: 'current-run', revision: 1 } }));
      mock.module(${JSON.stringify(client)}, { namedExports: { callTool: async (tool, args) => {
        const saved = JSON.parse(await readFile(output, 'utf8'));
        assert.equal(saved.data, null);
        assert.deepEqual(saved.pending, { tool, operationId: args.operationId });
        calls.push(args);
        if (calls.length === 1) throw new Error('SIMULATED_TIMEOUT');
        return { data: { id: 'current-run', phase: 'paused', revision: 2 } };
      } } });
      const { runProgress } = await import(${JSON.stringify(runner)});
      const args = () => ['control', '--context', context, '--action', 'pause', '--output', output];
      await assert.rejects(runProgress(args()), /SIMULATED_TIMEOUT/);
      assert.equal(JSON.parse(await readFile(output, 'utf8')).data, null);
      await runProgress(args());
      assert.equal(calls.length, 2);
      assert.equal(calls[0].operationId, calls[1].operationId);
      assert.equal(JSON.parse(await readFile(output, 'utf8')).data.id, 'current-run');
    } finally { mock.restoreAll(); await rm(directory, { recursive: true, force: true }); }
  `]);
});

test("travel days use a concise value in the final presentation", () => {
  assert.equal(formatTravelDays(6), "6");
  assert.equal(formatTravelDays(6.04), "6");
  assert.equal(formatTravelDays(6.14), "6.1");
  assert.equal(formatTravelDays(6.16), "6.2");
});

test("final travel delivery uses playful semantic emoji labels", () => {
  const output = renderDelivery({
    presentation: { content: "今天看见了雪山。", originalCost: "120", charged: "80", balance: "920", travelDays: 6 },
    itinerary: "第6天：看雪山",
    route: "拉萨 → 林芝",
    images: "![旅行纪念照](/tmp/memory.png)",
  });

  for (const label of ["📮 今天", "🧭 行程摘要", "🗺️ 实际路线", "🪙 原始费用", "💸 实际扣费", "👛 余额", "🗓️ 旅行日", "📸 旅行纪念照"])
    assert.match(output, new RegExp(label, "u"));
});
