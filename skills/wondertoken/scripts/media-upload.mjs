#!/usr/bin/env node
import { isMain } from "./local.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cli, localConnection } from "./local.mjs";
import { callTool } from "./client.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptRoot, "..");
const acceptedExtensions = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableOperationId(input) {
  const hex = createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function mimeTypeFor(path) {
  const mimeType = acceptedExtensions.get(extname(path).toLowerCase());
  if (!mimeType) throw new Error("UNSUPPORTED_IMAGE_TYPE");
  return mimeType;
}


async function upload({ endpoint, bytes, mimeType, operationId, headers = {} }) {
  if (bytes.length === 0) throw new Error("EMPTY_IMAGE");
  if (bytes.length > 10 * 1024 * 1024) throw new Error("IMAGE_TOO_LARGE");
  const { playerKey, mcpUrl } = await localConnection();
  const response = await fetch(new URL(endpoint, mcpUrl), {
    method: "POST",
    headers: {
      "content-type": mimeType,
      "x-wondertoken-player-key": playerKey,
      "x-wondertoken-operation-id": operationId,
      ...headers,
    },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error?.code ?? `MEDIA_UPLOAD_HTTP_${response.status}`);
  }
  return payload.data;
}

export async function uploadPetVisual({
  file,
  displayName,
  description,
  spriteSheet = false,
}, {
  ensurePlayer = () => callTool("ensure_player"),
  uploadImage = upload,
  readPreview = (uploadId) => callTool("get_pet_visual_image", { uploadId }),
} = {}) {
  const bytes = await readFile(file);
  const mimeType = mimeTypeFor(file);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  const metadata = {
    purpose: "pet-visual",
    fingerprint,
    displayName: String(displayName).trim().slice(0, 80),
    description: String(description).trim().slice(0, 240),
    spriteSheet: Boolean(spriteSheet),
  };
  // A new player must exist before the media endpoint can own the upload.
  // ensure_player is idempotent and keeps the existing local identity.
  const player = await ensurePlayer();
  if (player?.error) throw new Error(player.error.code ?? "PLAYER_INITIALIZATION_FAILED");
  if (player?.data?.ready !== true) throw new Error("PLAYER_INITIALIZATION_FAILED");
  const uploaded = await uploadImage({
    endpoint: "/media/pet-visual",
    bytes,
    mimeType,
    operationId: stableOperationId(metadata),
    headers: {
      "x-pet-display-name-uri": encodeURIComponent(metadata.displayName),
      "x-pet-description-uri": encodeURIComponent(metadata.description),
      "x-pet-spritesheet": String(metadata.spriteSheet),
    },
  });
  // Preview delivery is independent of a successful upload. Old servers and
  // attachment failures must preserve the upload ID instead of prompting a retry.
  try {
    const preview = await readPreview(uploaded.uploadId);
    if (preview?.error) return { ...uploaded, preview: { status: "unavailable", reason: preview.error.code } };
    if (!preview?.attachments?.length) return { ...uploaded, preview: { status: "unavailable", reason: "PET_PREVIEW_ATTACHMENT_MISSING" } };
    return { ...uploaded, attachments: preview.attachments, preview: { status: "succeeded" } };
  } catch (error) {
    return { ...uploaded, preview: { status: "unavailable", reason: error?.message ?? "PET_PREVIEW_FAILED" } };
  }
}

export async function uploadMemoryImage({ journeyId, file }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(journeyId)) {
    throw new Error("INVALID_JOURNEY_ID");
  }
  const bytes = await readFile(file);
  const mimeType = mimeTypeFor(file);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  return upload({
    endpoint: `/media/journeys/${journeyId}/memory-image`,
    bytes,
    mimeType,
    operationId: stableOperationId({ purpose: "journey-memory-image", journeyId, fingerprint }),
  });
}

function flags(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item?.startsWith("--")) throw new Error("INVALID_ARGUMENT");
    const name = item.slice(2);
    if (name === "sprite-sheet") {
      parsed.spriteSheet = true;
    } else {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`MISSING_${name.toUpperCase().replaceAll("-", "_")}`);
      parsed[name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    }
  }
  return parsed;
}

async function main() {
  const command = process.argv[2];
  const input = flags(process.argv.slice(3));
  const data = command === "pet"
    ? await uploadPetVisual(input)
    : command === "memory"
      ? await uploadMemoryImage(input)
      : (() => { throw new Error("USAGE: media-upload.sh pet|memory --file PATH ..."); })();
  console.log(JSON.stringify(data));
}

export async function runCli() { await cli(main); }
if (isMain(import.meta.url)) await runCli();
