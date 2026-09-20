import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(repositoryRoot, "skills/wondertoken");
const skill = await readFile(resolve(root, "SKILL.md"), "utf8");
const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
assert.match(frontmatter[1], /^name: wondertoken$/m);
assert.match(frontmatter[1], /^description: .+$/m);
assert.match(frontmatter[1], /^license: PolyForm Noncommercial 1\.0\.0 \(software\); CC BY-NC-SA 4\.0 \(documentation and images\)$/m);
assert.match(frontmatter[1], /^metadata:\r?\n  wondertoken-runtime: Node\.js 24\.14\+ .+HTTPS.+$/m);
assert.doesNotMatch(skill, /\[TODO:|absolute-plugin-root|向上两级/);

async function checkMarkdown(file) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/\]\(([^)]+\.md)\)/g)) {
    if (!/^https?:/.test(match[1])) await access(resolve(dirname(file), match[1]));
  }
}

await checkMarkdown(resolve(root, "SKILL.md"));
for (const file of await readdir(resolve(root, "references"))) {
  if (file.endsWith(".md")) await checkMarkdown(resolve(root, "references", file));
}
for (const file of ["identity.mjs", "setup.mjs", "client.mjs", "progress-workflow.mjs", "local.mjs", "runtime.mjs", "tokscale-snapshot.mjs", "media-upload.mjs", "offline-travel.mjs", "pet-visual.mjs"]) {
  await access(resolve(root, "scripts", file));
}
for (const pet of ["shiba", "corgi", "orange-cat", "black-cat", "lop-rabbit", "little-fox"]) {
  await access(resolve(root, "assets/pets", `${pet}.png`));
}
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
assert.deepEqual(pkg.dependencies, lock.packages[""].dependencies);
const metadata = await readFile(resolve(root, "agents/openai.yaml"), "utf8");
assert.doesNotMatch(metadata, /\btype:\s*["']?mcp\b/);
const defaults = JSON.parse(await readFile(resolve(root, "defaults.json"), "utf8"));
assert.equal(defaults.schemaVersion, 1);
if (defaults.mcpUrl !== null) {
  const { validateMcpUrl } = await import("../skills/wondertoken/scripts/local.mjs");
  validateMcpUrl(defaults.mcpUrl);
}
console.log("Independent WonderToken Skill structure validated.");
