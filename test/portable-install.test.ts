import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
// @ts-expect-error plain ESM installer
import { install } from "../scripts/install-skill.mjs";
// @ts-expect-error portable ESM helper
import { installationStatus } from "../skills/wondertoken/scripts/installation.mjs";
import { skillPath } from "./paths.js";
const execute = promisify(execFile);

test("independent skill installs in a Unicode path, upgrades without changing identity, and uninstalls only its files", async () => {
  const root = await mkdtemp(join(tmpdir(), "wondertoken-portable-"));
  const target = join(root, "中文 path", "wondertoken");
  const state = join(root, "shared state");
  const installed = await install({ target, dependencies: false });
  assert.equal((await installationStatus(target)).status, "verified");
  assert.equal(installed.release.protocol, "progress-session-v1");
  await writeFile(join(target, "scripts/progress-intent.mjs"), "// stale or modified installation\n");
  assert.equal((await installationStatus(target)).status, "modified");
  await install({ target, dependencies: false });
  assert.equal((await installationStatus(target)).status, "verified");
  assert.equal(typeof installed.serviceConfigured, "boolean");
  const env = { ...process.env, WONDERTOKEN_STATE_DIR: state };
  const identityScript = join(target, "scripts/identity.mjs");
  const first = JSON.parse((await execute(process.execPath, [identityScript, "ensure"], { env, cwd: tmpdir() })).stdout);
  await execute(process.execPath, [join(target, "scripts/setup.mjs"), "configure", "--url", "https://selfhost.example.test/mcp"], { env });
  await install({ target, dependencies: false });
  const second = JSON.parse((await execute(process.execPath, [identityScript, "ensure"], { env })).stdout);
  assert.equal(first.playerKey, second.playerKey);
  let diagnostic;
  try {
    diagnostic = await execute(process.execPath, [join(target, "scripts/setup.mjs"), "doctor", "--offline"], { env });
  } catch (error) {
    // This deliberately dependency-free install must be reported as unready even offline.
    diagnostic = error as { stdout: string };
  }
  const report = JSON.parse(diagnostic.stdout);
  assert.equal(report.connectionMode, "skill-client");
  assert.equal(report.clientReady, false);
  assert.equal(report.clientRecovery.command, "npm");
  assert.ok(report.clientRecovery.args.includes(await realpath(target)));
  assert.equal(report.nativeMcpConfiguration, undefined);
  assert.equal(report.mcpUrl, "https://selfhost.example.test/mcp");
  assert.equal(report.sqliteReady, true); assert.equal(report.imageCapability.status, "unknown");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(first.playerKey));
  await access(join(target, "assets/pets/shiba.png"));
  const uninstalled = await install({ target, uninstall: true });
  assert.equal(uninstalled.identityPreserved, true);
  await assert.rejects(() => access(target));
  assert.equal(JSON.parse(await readFile(join(state, "player.json"), "utf8")).playerKey, first.playerKey);
});

test("several agent processes share a single atomically-created identity", async () => {
  const state = await mkdtemp(join(tmpdir(), "wondertoken-concurrent-"));
  const script = skillPath("scripts", "identity.mjs");
  const output = await Promise.all(Array.from({ length: 6 }, () => execute(process.execPath, [script, "ensure"], {
    env: { ...process.env, WONDERTOKEN_STATE_DIR: state },
  })));
  const keys = new Set(output.map((item) => JSON.parse(item.stdout).playerKey));
  assert.equal(keys.size, 1);
  await writeFile(join(state, "player.json"), '{"playerKey":"corrupt"}');
  await assert.rejects(() => execute(process.execPath, [script, "ensure"], { env: { ...process.env, WONDERTOKEN_STATE_DIR: state } }), /INVALID_LOCAL_PLAYER_KEY/);
  assert.equal(JSON.parse(await readFile(join(state, "player.json"), "utf8")).playerKey, "corrupt");
});

test("installer refuses to replace an unmanaged directory or the skill source", async () => {
  const target = await mkdtemp(join(tmpdir(), "wondertoken-unmanaged-"));
  await writeFile(join(target, "keep.txt"), "user file");
  await assert.rejects(() => install({ target, dependencies: false }), /TARGET_EXISTS_NOT_MANAGED/);
  await assert.rejects(() => install({ target: skillPath(), dependencies: false }), /OVERLAPS_SOURCE/);
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "user file");
});
