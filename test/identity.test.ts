import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { skillPath } from "./paths.js";

const execFileAsync = promisify(execFile);
const script = skillPath("scripts", "identity.mjs");

test("identity helper creates and reuses one protected player key", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "wondertoken-identity-test-"));
  const env = { ...process.env, WONDERTOKEN_STATE_DIR: stateDir };
  const first = JSON.parse((await execFileAsync(process.execPath, [script, "ensure"], { env })).stdout);
  const second = JSON.parse((await execFileAsync(process.execPath, [script, "ensure"], { env })).stdout);
  assert.match(first.playerKey, /^[a-f0-9]{64}$/);
  assert.equal(first.playerKey, second.playerKey);
  const file = await stat(join(stateDir, "player.json"));
  if (process.platform !== "win32") assert.equal(file.mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(stateDir, "player.json"), "utf8")).playerKey, first.playerKey);
});

test("different local state directories create different anonymous device accounts", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "wondertoken-identity-a-"));
  const secondDir = await mkdtemp(join(tmpdir(), "wondertoken-identity-b-"));
  const first = JSON.parse((await execFileAsync(process.execPath, [script, "ensure"], {
    env: { ...process.env, WONDERTOKEN_STATE_DIR: firstDir },
  })).stdout);
  const second = JSON.parse((await execFileAsync(process.execPath, [script, "ensure"], {
    env: { ...process.env, WONDERTOKEN_STATE_DIR: secondDir },
  })).stdout);
  assert.notEqual(first.playerKey, second.playerKey);
});
