#!/usr/bin/env node
import { isMain, errorDetails } from "./local.mjs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cli, connectionConfig, stateRoot, skillRoot, readJson, withStateLock, protect, validateMcpUrl } from "./local.mjs";
import { ensureIdentity } from "./identity.mjs";
import { checkTokscale } from "./tokscale-snapshot.mjs";
import { installationStatus } from "./installation.mjs";

export function doctorNext(report) {
  return !report.runtimeReady ? "安装 Node.js 24.14+（24 LTS），重新打开当前 Agent 后再次运行 doctor。"
    : !report.sqliteReady ? "当前 Node.js 缺少可用 SQLite；安装 Node.js 24.14+（24 LTS）后再次运行 doctor。"
      : !report.identityReady ? "允许当前 Agent 写入 WonderToken 私有状态目录后，再次运行 doctor。"
        : !report.clientReady ? "按 clientRecovery 给出的 npm ci 参数补齐随包依赖，再次运行 doctor。"
          : report.connectionError?.recovery === "request_host_permission"
            ? "通过当前宿主的正式权限机制允许同一 doctor 命令访问已配置服务，然后原样重试；不要改用离线旅行或另一个身份。"
            : report.networkChecked === false
              ? "离线诊断已完成；尚未检查旅行服务连接。正常游玩前运行不带 --offline 的 doctor。"
              : report.serviceReady === false
              ? "检查已配置服务地址和网络；保持同一身份与参数重试。只有满足 Skill 定义的真实网络故障时才考虑已有离线许可。"
              : "旅行信箱已接通。可以说：开始玩途。首次免费旅行无需 Tokscale；图片能力由当前 Agent 检查。";
}

export async function configure(mcpUrl) {
  const normalized = validateMcpUrl(mcpUrl);
  return withStateLock("config", async () => {
    const path = join(stateRoot, "config.json");
    const existing = await readJson(path) ?? {};
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...existing, schemaVersion: 1, mcpUrl: normalized }, null, 2) + "\n", { mode: 0o600 });
    await protect(temporary);
    await rename(temporary, path);
    return { configured: true, mcpUrl: normalized, identityPreserved: true };
  });
}
export async function doctor({ network = true } = {}) {
  const report = { platform: process.platform, node: process.versions.node, networkChecked: network, runtimeReady: /^24\./.test(process.versions.node) && Number(process.versions.node.split(".")[1]) >= 14 };
  try { await import("node:sqlite"); report.sqliteReady = true; } catch { report.sqliteReady = false; }
  try { await ensureIdentity(); report.identityReady = true; } catch (error) { report.identityReady = false; report.identityError = error.message; }
  report.connectionMode = "skill-client";
  report.installation = await installationStatus();
  let withClient;
  try {
    ({ withClient } = await import("./client.mjs"));
    report.clientReady = true;
  } catch (error) {
    report.clientReady = false;
    report.clientError = error.code ?? error.message;
    report.clientRecovery = {
      command: "npm",
      args: ["ci", "--prefix", skillRoot, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      next: "由 Agent 在安装授权范围内补齐随包锁定依赖，再重新运行 doctor。无需配置宿主 MCP。",
    };
  }
  try { report.tokscale = await checkTokscale(); } catch (error) { report.tokscale = { ready: false, reason: error.message }; }
  report.imageCapability = { status: "unknown", next: "Agent must inspect available tools and installed image Skills; this script cannot observe host tools." };
  try {
    const { mcpUrl } = await connectionConfig();
    report.mcpUrl = mcpUrl;
    report.serviceConfigured = true;
    if (network && report.clientReady) {
      const config = await withClient((client) => client.callTool({ name: "get_game_config", arguments: {} }));
      report.serviceReady = !config.isError;
      const body = config.structuredContent;
      report.progressProtocol = body?.data?.progressProtocol ?? body?.progressProtocol ?? null;
    }
  } catch (error) { report.serviceReady = false; report.serviceError = errorDetails(error).error; report.connectionError = errorDetails(error); }
  report.next = doctorNext(report);
  return report;
}
export async function runCli() {
  await cli(async () => {
    const command = process.argv[2] ?? "doctor";
    if (command === "configure") {
      if (process.argv[3] !== "--url" || !process.argv[4]) throw new Error("USAGE: setup.mjs configure --url MCP_URL");
      console.log(JSON.stringify(await configure(process.argv[4]))); return;
    }
    if (command !== "doctor") throw new Error("USAGE: setup.mjs doctor [--offline] | configure --url MCP_URL");
    const report = await doctor({ network: !process.argv.includes("--offline") });
    console.log(JSON.stringify(report));
    if (!report.runtimeReady || !report.identityReady || !report.sqliteReady || !report.clientReady || report.serviceReady === false) process.exitCode = 1;
  });
}
if (isMain(import.meta.url)) await runCli();
