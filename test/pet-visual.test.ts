import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { skillPath } from "./paths.js";

const script = skillPath("scripts", "pet-visual.mjs");
const optionsScript = skillPath("scripts", "pet-options.mjs");
const mediaScript = skillPath("scripts", "media-upload.mjs");
const skill = skillPath("SKILL.md");

function run(codexRoot: string, command = "discover", avatarId?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [script, command, ...(avatarId ? [avatarId] : [])], {
      env: { ...process.env, WONDERTOKEN_CODEX_ROOT: codexRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolveRun({ code: code ?? 1, stdout: stdout || stderr }),
    );
  });
}

function runOptions(codexRoot: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [optionsScript], {
      env: { ...process.env, WONDERTOKEN_CODEX_ROOT: codexRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code: code ?? 1, stdout: stdout || stderr }));
  });
}

test("pet options always return all six packaged official images with absolute paths", async () => {
  const codexRoot = await mkdtemp(join(tmpdir(), "wondertoken-pet-options-"));
  const result = await runOptions(codexRoot);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.official.map((pet: { assetId: string }) => pet.assetId), [
    "shiba", "corgi", "orange-cat", "black-cat", "lop-rabbit", "little-fox",
  ]);
  assert.ok(output.official.every((pet: { imagePath: string }) => pet.imagePath.startsWith("/") && pet.imagePath.endsWith(".png")));
  assert.equal(output.custom.status, "none");
});

test("pet options retain multiple custom candidates as a normal selection state", async () => {
  const codexRoot = await mkdtemp(join(tmpdir(), "wondertoken-pet-options-"));
  for (const name of ["Momo", "Nana"]) {
    const petRoot = join(codexRoot, "pets", name);
    await mkdir(petRoot, { recursive: true });
    await writeFile(join(petRoot, "pet.json"), JSON.stringify({ displayName: name, spritesheetPath: "sheet.png" }));
    await writeFile(join(petRoot, "sheet.png"), "fixture");
  }
  const result = await runOptions(codexRoot);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.custom.status, "selection-required");
  assert.deepEqual(output.custom.candidates.map((pet: { avatarId: string }) => pet.avatarId), [
    "custom:Momo", "custom:Nana",
  ]);
});

test("pet visual helper discovers the active custom Codex Pet", async () => {
  const codexRoot = await mkdtemp(join(tmpdir(), "wondertoken-codex-pet-"));
  const petRoot = join(codexRoot, "pets", "Momo");
  await mkdir(petRoot, { recursive: true });
  await writeFile(join(codexRoot, "config.toml"), 'selected-avatar-id = "custom:Momo"\n');
  await writeFile(
    join(petRoot, "pet.json"),
    JSON.stringify({ displayName: "默默", description: "一只安静的宠物", spritesheetPath: "sheet.webp" }),
  );
  await writeFile(join(petRoot, "sheet.webp"), "fixture");
  const result = await run(codexRoot);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.found, true);
  assert.equal(output.displayName, "默默");
  assert.equal(output.imagePath, join(petRoot, "sheet.webp"));
});

test("pet visual helper cleanly falls back for an unreadable built-in pet", async () => {
  const codexRoot = await mkdtemp(join(tmpdir(), "wondertoken-codex-pet-"));
  await writeFile(join(codexRoot, "config.toml"), 'selected-avatar-id = "builtin:shiba"\n');
  const result = await run(codexRoot);
  assert.equal(result.code, 3);
  assert.deepEqual(JSON.parse(result.stdout), {
    found: false,
    reason: "NO_CUSTOM_CODEX_PET",
    selectedAvatarId: "builtin:shiba",
  });
});

test("pet visual helper uses the only custom pet even without an active selection", async () => {
  const codexRoot = await mkdtemp(join(tmpdir(), "wondertoken-codex-pet-"));
  const petRoot = join(codexRoot, "pets", "Momo");
  await mkdir(petRoot, { recursive: true });
  await writeFile(
    join(petRoot, "pet.json"),
    JSON.stringify({ displayName: "默默", spritesheetPath: "sheet.png" }),
  );
  await writeFile(join(petRoot, "sheet.png"), "fixture");
  const result = await run(codexRoot);
  const output = JSON.parse(result.stdout);
  assert.equal(result.code, 0);
  assert.equal(output.selection, "only");
  assert.equal(output.avatarId, "custom:Momo");
});

test("pet visual helper prefers the active custom pet when several are available", async () => {
  const codexRoot = await mkdtemp(join(tmpdir(), "wondertoken-codex-pet-"));
  await writeFile(join(codexRoot, "config.toml"), 'selected-avatar-id = "custom:Nana"\n');
  for (const name of ["Momo", "Nana"]) {
    const petRoot = join(codexRoot, "pets", name);
    await mkdir(petRoot, { recursive: true });
    await writeFile(
      join(petRoot, "pet.json"),
      JSON.stringify({ displayName: name, spritesheetPath: "sheet.png" }),
    );
    await writeFile(join(petRoot, "sheet.png"), "fixture");
  }
  const result = await run(codexRoot);
  const output = JSON.parse(result.stdout);
  assert.equal(result.code, 0);
  assert.equal(output.selection, "active");
  assert.equal(output.avatarId, "custom:Nana");
});

test("pet visual helper requires a choice only for multiple custom pets without an active one", async () => {
  const codexRoot = await mkdtemp(join(tmpdir(), "wondertoken-codex-pet-"));
  for (const name of ["Momo", "Nana"]) {
    const petRoot = join(codexRoot, "pets", name);
    await mkdir(petRoot, { recursive: true });
    await writeFile(
      join(petRoot, "pet.json"),
      JSON.stringify({ displayName: name, spritesheetPath: "sheet.png" }),
    );
    await writeFile(join(petRoot, "sheet.png"), "fixture");
  }
  const result = await run(codexRoot);
  const output = JSON.parse(result.stdout);
  assert.equal(result.code, 3);
  assert.equal(output.reason, "CUSTOM_PET_SELECTION_REQUIRED");
  assert.deepEqual(output.candidates.map((candidate: { avatarId: string }) => candidate.avatarId), [
    "custom:Momo",
    "custom:Nana",
  ]);
});

test("memory images use the already stored pet visual on the service", async () => {
  const instructions = await readFile(skill, "utf8");
  assert.match(instructions, /generate_memory_image/u);
  assert.match(instructions, /服务端直接使用领养时已存档的宠物形象/u);
  assert.match(instructions, /绝不重新读取、发送或上传本地 Codex Pet 图片/u);
  assert.doesNotMatch(instructions, /prepare_memory_image/u);
  assert.doesNotMatch(instructions, /media-upload\.mjs.*memory/u);
});

test("first pet upload initializes its owner before uploading and preserves retry identity", async () => {
  const { uploadPetVisual } = await import(mediaScript);
  const file = skillPath("assets", "pets", "shiba.png");
  const events: string[] = [];
  const ids: string[] = [];
  const dependencies = {
    ensurePlayer: async () => { events.push("ensure"); return { data: { ready: true } }; },
    uploadImage: async (input: { operationId: string }) => {
      events.push("upload"); ids.push(input.operationId); return { uploadId: "saved" };
    },
    readPreview: async (uploadId: string) => {
      assert.equal(uploadId, "saved");
      return { attachments: [{ path: "/private/preview.png", mimeType: "image/png" }] };
    },
  };
  const input = { file, displayName: "Goku", description: "Chosen pet" };
  assert.deepEqual(await uploadPetVisual(input, dependencies), {
    uploadId: "saved",
    attachments: [{ path: "/private/preview.png", mimeType: "image/png" }],
    preview: { status: "succeeded" },
  });
  await uploadPetVisual(input, dependencies);
  assert.deepEqual(events, ["ensure", "upload", "ensure", "upload"]);
  assert.equal(ids[0], ids[1]);
  for (const response of [{ error: { code: "INVALID_PLAYER_KEY" } }, {}]) {
    await assert.rejects(() => uploadPetVisual(input, {
      ...dependencies, ensurePlayer: async () => response,
    }), /INVALID_PLAYER_KEY|PLAYER_INITIALIZATION_FAILED/u);
  }
  assert.equal(ids.length, 2, "failed initialization must not upload media");
});

test("media helper derives stable opaque operation IDs without exposing the player key", async () => {
  const { stableOperationId } = await import(mediaScript);
  const input = { purpose: "pet-visual", fingerprint: "a".repeat(64), displayName: "团子" };
  const first = stableOperationId(input);
  assert.equal(first, stableOperationId({ ...input }));
  assert.notEqual(first, stableOperationId({ ...input, displayName: "小满" }));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  const helperSource = await readFile(mediaScript, "utf8");
  assert.match(helperSource, /\/media\/pet-visual/u);
  assert.match(helperSource, /\/media\/journeys\/\$\{journeyId\}\/memory-image/u);
  assert.doesNotMatch(helperSource, /console\.log\([^\n]*playerKey/u);
});

test("preview failure preserves a successful pet upload without retrying it", async () => {
  const { uploadPetVisual } = await import(mediaScript);
  let uploads = 0;
  const uploaded = { uploadId: "saved", image: { status: "succeeded", url: "https://media.example/pet.png" } };
  for (const readPreview of [
    async () => { throw new Error("WONDERTOKEN_TOOL_NOT_FOUND"); },
    async () => ({ error: { code: "PET_VISUAL_UPLOAD_NOT_FOUND" } }),
    async () => ({ data: { uploadId: "saved" } }),
  ]) {
    const result = await uploadPetVisual({
      file: skillPath("assets", "pets", "shiba.png"),
      displayName: "Goku", description: "Chosen pet",
    }, {
      ensurePlayer: async () => ({ data: { ready: true } }),
      uploadImage: async () => { uploads++; return uploaded; },
      readPreview,
    });
    assert.equal(result.uploadId, uploaded.uploadId);
    assert.deepEqual(result.image, uploaded.image);
    assert.equal(result.preview.status, "unavailable");
    assert.ok(result.preview.reason);
  }
  assert.equal(uploads, 3);
});
