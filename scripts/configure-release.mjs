import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMain, skillRoot, validateMcpUrl } from "../skills/wondertoken/scripts/local.mjs";

export async function configureRelease(value, directory = skillRoot) {
  if (!value) throw new Error("USAGE: node scripts/configure-release.mjs OFFICIAL_HTTPS_MCP_URL");
  const url = validateMcpUrl(value);
  if (!url.startsWith("https://") || /(^|[./])(?:example|test|localhost)(?:[./:]|$)/.test(url)) {
    throw new Error("OFFICIAL_HTTPS_URL_REQUIRED");
  }
  await writeFile(join(directory, "defaults.json"), JSON.stringify({ schemaVersion: 1, mcpUrl: url }, null, 2) + "\n");
  return { configured: true, mcpUrl: url, connectionMode: "skill-client" };
}

if (isMain(import.meta.url)) {
  await configureRelease(process.argv[2]);
  console.log("WonderToken distribution default updated.");
}

