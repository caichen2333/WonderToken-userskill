import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { skillRoot, readJson } from "./local.mjs";
import { PROGRESS_PROTOCOL } from "./progress-intent.mjs";

// Defaults are connection configuration, retained on upgrade, not executable code.
export async function releaseFingerprint(root = skillRoot) {
  const files = [];
  async function visit(relative) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".") || (!relative && entry.name === "defaults.json")) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("SKILL_RELEASE_SYMLINK_NOT_ALLOWED");
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  await visit("");
  const hash = createHash("sha256");
  for (const file of files.sort()) hash.update(file).update("\0").update(await readFile(join(root, file))).update("\0");
  return { protocol: PROGRESS_PROTOCOL, sha256: hash.digest("hex"), fileCount: files.length };
}

export async function installationStatus(root = skillRoot) {
  const actual = await releaseFingerprint(root);
  const marker = await readJson(join(root, ".wondertoken-install.json"));
  return { path: root, ...actual,
    status: !marker ? "source-or-unmanaged" : !marker.release ? "legacy-install"
      : marker.release.sha256 === actual.sha256 && marker.release.protocol === actual.protocol ? "verified" : "modified",
    hostPermissions: "not-granted-by-skill; validate-in-host",
  };
}
