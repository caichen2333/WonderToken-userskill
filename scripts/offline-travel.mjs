#!/usr/bin/env node
// Compatibility entry; the portable skill owns the implementation.
export * from "../skills/wondertoken/scripts/offline-travel.mjs";
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { runCli } = await import("../skills/wondertoken/scripts/offline-travel.mjs");
  await runCli();
}
