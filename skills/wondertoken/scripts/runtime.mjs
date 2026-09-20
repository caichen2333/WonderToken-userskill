import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawn } from "node:child_process";

export async function executable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const path = join(directory, name + suffix);
      try { await access(path, constants.X_OK); return path; } catch {}
    }
  }
  return null;
}
export async function npmCommand(kind = "npm") {
  const executablePath = await executable(kind);
  const directories = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)];
  if (executablePath) {
    const resolved = await realpath(executablePath);
    if (resolved.endsWith(".js")) return { command: process.execPath, prefix: [resolved] };
    directories.unshift(dirname(executablePath));
  }
  for (const directory of directories) {
    for (const relative of [`node_modules/npm/bin/${kind}-cli.js`, `../lib/node_modules/npm/bin/${kind}-cli.js`]) {
      const path = join(directory, relative);
      try { await access(path); return { command: process.execPath, prefix: [path] }; } catch {}
    }
  }
  throw new Error("NPM_RUNTIME_MISSING");
}
export function run(command, args, { cwd, env = process.env, timeout = 120_000, maximumBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("COMMAND_TIMEOUT")); }, timeout);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) { child.kill(); reject(new Error("COMMAND_OUTPUT_TOO_LARGE")); }
      else stdout += chunk;
    });
    // Do not expose upstream paths or transcripts in diagnostic output.
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`COMMAND_FAILED_${code}`)); });
  });
}
