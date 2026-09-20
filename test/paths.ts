import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const skillPath = (...parts: string[]) => join(pluginRoot, "skills", "wondertoken", ...parts);

