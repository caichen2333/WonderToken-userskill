#!/usr/bin/env node
import { isMain } from "./local.mjs";
import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cli, stateRoot, readJson, protect, withStateLock } from "./local.mjs";

export async function ensureIdentity() {
  // Existing identities need no lock, chmod, or write outside the workspace.
  // Creation still uses the locked path and rechecks after acquiring the lock.
  const existingPath = join(stateRoot, "player.json");
  const existing = await readJson(existingPath);
  if (existing) {
    if (!/^[a-f0-9]{64}$/.test(existing.playerKey)) throw new Error("INVALID_LOCAL_PLAYER_KEY");
    return { ...existing, statePath: existingPath };
  }
  return withStateLock("identity", async () => {
    const path = join(stateRoot, "player.json");
    let state = await readJson(path);
    if (state && !/^[a-f0-9]{64}$/.test(state.playerKey)) throw new Error("INVALID_LOCAL_PLAYER_KEY");
    if (!state) {
      state = { schemaVersion: 1, playerKey: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() };
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await protect(temporary);
      await rename(temporary, path);
    }
    await protect(path);
    return { ...state, statePath: path };
  });
}
export async function runCli() {
  await cli(async () => {
    if ((process.argv[2] ?? "ensure") !== "ensure") throw new Error("USAGE: identity.mjs ensure");
    console.log(JSON.stringify(await ensureIdentity()));
  });
}
if (isMain(import.meta.url)) await runCli();
