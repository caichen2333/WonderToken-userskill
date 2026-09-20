#!/usr/bin/env node
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./local.mjs";
import { discover } from "./pet-visual.mjs";

const skillRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const officialCatalog = [
  ["shiba", "柴犬", "温暖好奇"],
  ["corgi", "柯基", "热情可靠"],
  ["orange-cat", "橘猫", "从容贪吃"],
  ["black-cat", "黑猫", "安静机敏"],
  ["lop-rabbit", "垂耳兔", "温柔细心"],
  ["little-fox", "小狐狸", "聪明勇敢"],
];

export async function listPetOptions() {
  const official = await Promise.all(officialCatalog.map(async ([assetId, displayName, description]) => {
    const imagePath = resolve(skillRoot, "assets", "pets", `${assetId}.png`);
    await access(imagePath);
    return { source: "official", assetId, displayName, description, imagePath };
  }));
  try {
    const discovered = await discover({ detailed: true });
    const candidates = discovered.found
      ? [{ avatarId: discovered.avatarId, displayName: discovered.displayName,
          description: discovered.description, imagePath: discovered.imagePath,
          spriteSheet: discovered.spriteSheet, selection: discovered.selection }]
      : discovered.candidates ?? [];
    return {
      official,
      custom: {
        status: discovered.petsDirectoryStatus === "unreadable" ? "scan-failed"
          : discovered.found ? "found"
            : discovered.reason === "CUSTOM_PET_SELECTION_REQUIRED" ? "selection-required" : "none",
        candidates,
        ...(discovered.selectedAvatarId ? { selectedAvatarId: discovered.selectedAvatarId } : {}),
        diagnostics: {
          configStatus: discovered.configStatus,
          petsDirectoryStatus: discovered.petsDirectoryStatus,
          ignoredDirectories: discovered.ignoredDirectories,
        },
      },
    };
  } catch (error) {
    return { official, custom: { status: "scan-failed", candidates: [],
      error: error?.code ?? error?.message ?? "CUSTOM_PET_SCAN_FAILED" } };
  }
}

if (isMain(import.meta.url)) console.log(JSON.stringify(await listPetOptions()));
