import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { skillPath } from "./paths.js";

const skill = skillPath("SKILL.md");

test("progress replies always describe cumulative travel duration in virtual travel days", async () => {
  const instructions = await readFile(skill, "utf8");

  assert.match(instructions, /`\u23f1\ufe0f 已旅行时长`/u);
  assert.match(instructions, /`stateAfter\.elapsedTravelDays` 为准/u);
  assert.match(instructions, /例如“🗓️ 旅行日：6 个旅行日”/u);
  assert.match(instructions, /不能只藏在路线、足迹、旅程或嵌套状态中/u);
  assert.match(instructions, /旅行来信用 `📮`，行程用 `🧭`，路线用 `🗺️`/u);
  assert.match(instructions, /正文每个自然段最多再点缀 1 个/u);
  assert.match(instructions, /不换算成现实时长/u);
  assert.match(instructions, /`progressAvailable: false`，只反馈已旅行时长/u);
});
