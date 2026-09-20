import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
// @ts-expect-error portable ESM helper
import { doctorNext } from "../skills/wondertoken/scripts/setup.mjs";
import { skillPath } from "./paths.js";

const execute = promisify(execFile);
const client = skillPath("scripts", "client.mjs");
const progressRun = skillPath("scripts", "progress-run.mjs");

test("client help exits successfully with runnable examples", async () => {
  const { stdout } = await execute(process.execPath, [client, "--help"]);
  const help = JSON.parse(stdout);
  assert.match(help.usage, /--input input\.json \| --json JSON/);
  assert.ok(help.examples.includes("client.mjs call get_pet_soul"));
});

test("client accepts short inline JSON for low-reasoning compatibility without sending validation", async () => {
  const { stdout } = await execute(process.execPath, [client, "validate", "get_pet_soul", "--json", "{}"]);
  assert.deepEqual(JSON.parse(stdout), { valid: true, sent: false });
});

test("client reports empty and invalid JSON with actionable errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "wondertoken-cli-"));
  const empty = join(root, "empty.json");
  const invalid = join(root, "invalid.json");
  await writeFile(empty, ""); await writeFile(invalid, "{");
  const cases: Array<[string, string]> = [[empty, "EMPTY_JSON_INPUT"], [invalid, "INVALID_JSON_INPUT"]];
  for (const [path, message] of cases) {
    await assert.rejects(execute(process.execPath, [client, "validate", "get_pet_soul", "--input", path]),
      (error: unknown) => String((error as { stderr?: string }).stderr).includes(message));
  }
});

test("doctor recovery instruction follows the actual failure", () => {
  const ready = { runtimeReady: true, sqliteReady: true, identityReady: true, clientReady: true, serviceReady: true };
  assert.match(doctorNext({ ...ready, serviceReady: false,
    connectionError: { recovery: "request_host_permission" } }), /正式权限机制/);
  assert.doesNotMatch(doctorNext({ ...ready, serviceReady: false,
    connectionError: { recovery: "request_host_permission" } }), /启用 wondertoken/);
  assert.match(doctorNext({ ...ready, serviceReady: false,
    connectionError: { recovery: "check_connection" } }), /服务地址和网络/);
  assert.match(doctorNext(ready), /旅行信箱已接通/);
  assert.match(doctorNext({ ...ready, networkChecked: false, serviceReady: undefined }), /尚未检查旅行服务连接/);
});

test("v3 progress runner exposes complete help and rejects guessed flags before network access", async () => {
  const { stdout } = await execute(process.execPath, [progressRun, "--help"]);
  const help = JSON.parse(stdout);
  assert.match(help.usage, /run --source/);
  assert.match(help.usage, /resume --context/);
  assert.match(help.usage, /enrich --context/);
  assert.match(help.usage, /control --context/);
  await assert.rejects(execute(process.execPath, [progressRun, "run", "--json", "{}"]),
    (error: unknown) => String((error as { stderr?: string }).stderr).includes("INVALID_RUN_ARGUMENTS"));
});
