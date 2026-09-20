import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
// @ts-expect-error plain ESM release helper
import { configureRelease } from "../scripts/configure-release.mjs";
import { skillPath } from "./paths.js";

const execute = promisify(execFile);

test("Skill connection uses explicit, environment, user, then distribution settings; never legacy host MCP", async () => {
  const root = await mkdtemp(join(tmpdir(), "wondertoken-connection-"));
  const skill = join(root, "plugin/skills/wondertoken");
  const state = join(root, "state");
  try {
    await mkdir(join(skill, "scripts"), { recursive: true });
    await mkdir(state);
    await copyFile(skillPath("scripts", "local.mjs"), join(skill, "scripts/local.mjs"));
    const moduleUrl = pathToFileURL(join(skill, "scripts/local.mjs")).href;
    const env = { ...process.env, WONDERTOKEN_STATE_DIR: state, WONDERTOKEN_MCP_URL: "" };
    const query = async (url = "", explicit = "") => {
      const { stdout } = await execute(process.execPath, ["--input-type=module", "-e",
        `const { connectionConfig } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await connectionConfig(process.argv[1] || undefined)));`, explicit],
      { env: { ...env, WONDERTOKEN_MCP_URL: url } });
      return JSON.parse(stdout).mcpUrl;
    };
    const defaults = join(skill, "defaults.json");
    await writeFile(defaults, JSON.stringify({ schemaVersion: 1, mcpUrl: "https://distribution.example.test/mcp" }));
    await writeFile(join(root, "plugin/.mcp.json"), JSON.stringify({ mcpServers: { wondertoken: { url: "http://127.0.0.1:8787/mcp" } } }));
    assert.equal(await query(), "https://distribution.example.test/mcp");
    await writeFile(join(state, "config.json"), JSON.stringify({ mcpUrl: "https://user.example.test/mcp" }));
    assert.equal(await query(), "https://user.example.test/mcp");
    assert.equal(await query("https://env.example.test/mcp"), "https://env.example.test/mcp");
    assert.equal(await query("https://env.example.test/mcp", "https://explicit.example.test/mcp"), "https://explicit.example.test/mcp");
    await rm(join(state, "config.json"));
    await writeFile(defaults, JSON.stringify({ schemaVersion: 1, mcpUrl: null }));
    await assert.rejects(query(), /WONDERTOKEN_MCP_URL_NOT_CONFIGURED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release configuration writes one Skill default without requiring or creating host MCP metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "wondertoken-release-"));
  try {
    const result = await configureRelease("https://play.wondertoken.invalid/mcp", root);
    assert.equal(result.connectionMode, "skill-client");
    assert.deepEqual(await readdir(root), ["defaults.json"]);
    const written = await readFile(join(root, "defaults.json"), "utf8");
    assert.equal(JSON.parse(written).mcpUrl, "https://play.wondertoken.invalid/mcp");
    await assert.rejects(configureRelease("http://127.0.0.1:8787/mcp", root), /OFFICIAL_HTTPS_URL_REQUIRED/);
    assert.equal(await readFile(join(root, "defaults.json"), "utf8"), written);
  } finally { await rm(root, { recursive: true, force: true }); }
});
