#!/usr/bin/env node
import { isMain } from "./local.mjs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { cli } from "./local.mjs";
import { uploadPetVisual } from "./media-upload.mjs";


const codexRoot = process.env.WONDERTOKEN_CODEX_ROOT ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");

export async function discover({ detailed = false } = {}) {
  let selected;
  let configStatus = "read";
  try {
    const config = await readFile(join(codexRoot, "config.toml"), "utf8");
    selected = config.match(/^selected-avatar-id\s*=\s*"([^"]+)"/mu)?.[1];
  } catch (error) {
    configStatus = error?.code === "ENOENT" ? "missing" : "unreadable";
    // A missing config only means no active pet is known; custom pets can still exist.
  }

  const petsRoot = join(codexRoot, "pets");
  let directories = [];
  let petsDirectoryStatus = "read";
  try {
    directories = (await readdir(petsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    petsDirectoryStatus = error?.code === "ENOENT" ? "missing" : "unreadable";
    // No custom-pet directory is equivalent to no custom pet.
  }

  const ignoredDirectories = [];
  const candidates = await Promise.all(directories.map(async (directoryName) => {
    try {
      const petRoot = join(petsRoot, directoryName);
      const metadata = JSON.parse(await readFile(join(petRoot, "pet.json"), "utf8"));
      const imagePath = resolve(petRoot, String(metadata.spritesheetPath ?? ""));
      if (relative(petRoot, imagePath).startsWith("..") || isAbsolute(relative(petRoot, imagePath))) throw new Error("INVALID_PET_IMAGE_PATH");
      const extension = extname(imagePath).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
        throw new Error("UNSUPPORTED_PET_IMAGE");
      }
      return {
        avatarId: `custom:${directoryName}`,
        displayName: String(metadata.displayName ?? directoryName).slice(0, 80),
        description: String(metadata.description ?? "从当前 Codex Pet 导入的形象。").slice(0, 240),
        imagePath,
        spriteSheet: true,
      };
    } catch {
      ignoredDirectories.push(directoryName);
      return null;
    }
  }));
  const diagnostics = detailed ? { configStatus, petsDirectoryStatus, ignoredDirectories } : {};
  const usableCandidates = candidates.filter((candidate) => candidate !== null);
  const active = selected && selected.startsWith("custom:")
    ? usableCandidates.find((candidate) => candidate.avatarId === selected)
    : undefined;
  if (active) return { found: true, selection: "active", selectedAvatarId: selected, ...active, ...diagnostics };
  if (usableCandidates.length === 1) return { found: true, selection: "only", ...usableCandidates[0], ...diagnostics };
  if (usableCandidates.length > 1) {
    return { found: false, reason: "CUSTOM_PET_SELECTION_REQUIRED", candidates: usableCandidates, ...diagnostics };
  }
  return {
    found: false,
    reason: "NO_CUSTOM_CODEX_PET",
    ...(selected ? { selectedAvatarId: selected } : {}),
    ...diagnostics,
  };
}

export async function runCli() {
const command = process.argv[2] ?? "discover";
const requestedAvatarId = process.argv[3];
if (command !== "discover" && command !== "import") {
  console.error(JSON.stringify({ error: "USAGE: pet-visual.mjs discover|import [custom-pet-id]" }));
  process.exit(2);
}

let pet = await discover();
if (command === "discover") {
  console.log(JSON.stringify(pet));
  process.exit(pet.found ? 0 : 3);
}

if (!pet.found && pet.reason === "CUSTOM_PET_SELECTION_REQUIRED" && requestedAvatarId) {
  const selectedCandidate = pet.candidates.find((candidate) => candidate.avatarId === requestedAvatarId);
  if (!selectedCandidate) throw new Error("CODEX_PET_NOT_FOUND");
  pet = { found: true, selection: "chosen", ...selectedCandidate };
}

if (!pet.found) {
  console.log(JSON.stringify(pet));
  process.exit(3);
}

if (requestedAvatarId && requestedAvatarId !== pet.avatarId) {
  const selectedCandidate = pet.candidates?.find((candidate) => candidate.avatarId === requestedAvatarId);
  if (!selectedCandidate) throw new Error("CODEX_PET_NOT_FOUND");
  Object.assign(pet, selectedCandidate);
}

const uploaded = await uploadPetVisual({
  file: pet.imagePath,
  displayName: pet.displayName,
  description: pet.description,
  spriteSheet: true,
});
console.log(JSON.stringify({ imported: true, ...uploaded }));

}

if (isMain(import.meta.url)) await cli(runCli);
