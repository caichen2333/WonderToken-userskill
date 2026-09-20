import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
// @ts-expect-error portable ESM module
import { collectAndSettle, normalizeTokscale, snapshotHash } from "../skills/wondertoken/scripts/tokscale-snapshot.mjs";
import { skillPath } from "./paths.js";
const execFileAsync = promisify(execFile);
const script = skillPath("scripts", "tokscale-snapshot.mjs");

test("collector preserves all clients and aggregates multiple providers without host filtering", async () => {
  const bin = await mkdtemp(join(tmpdir(), "wondertoken-tokscale-"));
  const fake = join(bin, "fake.mjs");
  await writeFile(fake, `if (process.argv.includes('--version')) console.log('tokscale 4.14.0'); else console.log(JSON.stringify({entries:[
    {client:'codex',input:100,output:20,cacheRead:10,cacheWrite:5,reasoning:3},
    {client:'claude',input:400,output:30}, {client:'claude',input:600,cacheWrite:100},
    {client:'opencode',input:80}]}));`);
  const { stdout } = await execFileAsync(process.execPath, [script, "--collect"], {
    env: { ...process.env, WONDERTOKEN_TOKSCALE_COMMAND: fake },
  });
  const output = JSON.parse(stdout);
  assert.deepEqual(output.clientsFound, ["claude", "codex", "opencode"]);
  assert.equal(output.snapshot.clients[0].totals.input, "1000");
  assert.equal(output.snapshot.clients[1].totals.reasoning, "3");
  assert.equal(output.snapshot.snapshotHash, snapshotHash(output.snapshot));
});

test("snapshot bytes are independent of entry/provider order and retain zero-client records", () => {
  const entries = [{ client: "claude", input: 4 }, { client: "codex", input: 0 }, { client: "claude", input: 6 }];
  const a = normalizeTokscale({ entries }, "2026-09-08T00:00:00.000Z");
  const b = normalizeTokscale({ entries: [...entries].reverse() }, a.generatedAt);
  assert.deepEqual(a, b);
  assert.equal(a.clients[1].totals.input, "0");
  assert.equal(normalizeTokscale({ entries: [{ client: "claude", output: 8 }] }).clients.length, 1);
});

test("collector rejects empty, malformed and unsafe data rather than creating a partial snapshot", () => {
  for (const entries of [[], [{ client: "claude", input: -1 }], [{ client: "codex", input: 1.5 }],
    [{ client: "codex", input: Number.MAX_SAFE_INTEGER + 1 }], [{ client: "bad client", input: 1 }]]) {
    assert.throws(() => normalizeTokscale({ entries }));
  }
  assert.throws(() => normalizeTokscale({ nope: [] }), /ENTRIES_MISSING/);
});

test("one-pass settlement requires a private output path before collecting or connecting", async () => {
  await assert.rejects(() => collectAndSettle(), /TOKSCALE_SETTLE_OUTPUT_REQUIRED/);
});
