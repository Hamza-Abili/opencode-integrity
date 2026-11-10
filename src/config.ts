import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectory, isInside, pathExists, readJsoncFile, realPath } from "./util.ts";

export interface PluginRef {
  readonly target: string;
  readonly version?: string;
  readonly localPath?: string;
  /** Directory of the config file that declared this plugin. */
  readonly configDir?: string;
}

export interface ProjectConfig {
  readonly files: readonly string[];
  readonly plugins: readonly PluginRef[];
  readonly mcp: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginRef(value: unknown): PluginRef | undefined {
  if (typeof value === "string") {
    return value.trim().length > 0 ? { target: value.trim() } : undefined;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return { target: value[0] };
  }
  if (isObject(value) && typeof value.package === "string") {
    return { target: value.package };
  }
  return undefined;
}

function configPaths(directory: string): string[] {
  return [
    join(directory, "opencode.json"),
    join(directory, "opencode.jsonc"),
    join(directory, ".opencode", "opencode.json"),
    join(directory, ".opencode", "opencode.jsonc"),
  ];
}

function mcpFromConfig(data: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (!isObject(data.mcp)) return output;
  if (isObject(data.mcp.servers)) Object.assign(output, data.mcp.servers);
  for (const [name, value] of Object.entries(data.mcp)) {
    if (name === "servers" || name === "timeout") continue;
    if (isObject(value)) output[name] = value;
  }
  return output;
}

/** Global MCP servers, only used when `includeGlobal` is enabled. */
export async function loadGlobalMcp(home: string): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const path of [
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
  ]) {
    if (!(await pathExists(path))) continue;
    const data = await readJsoncFile(path);
    if (isObject(data)) Object.assign(output, mcpFromConfig(data));
  }
  return output;
}

/** Read the project-scoped OpenCode configuration. Global config is intentionally excluded. */
export async function loadProjectConfig(directory: string): Promise<ProjectConfig> {
  const files: string[] = [];
  const plugins: PluginRef[] = [];
  const mcp: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const path of configPaths(directory)) {
    if (!(await pathExists(path))) continue;
    const data = await readJsoncFile(path);
    if (!isObject(data)) {
      warnings.push(`${path}: unreadable or invalid JSONC`);
      continue;
    }
    files.push(path);
    const values = [
      ...(Array.isArray(data.plugins) ? data.plugins : []),
      ...(Array.isArray(data.plugin) ? data.plugin : []),
    ];
    for (const value of values) {
      const ref = pluginRef(value);
      if (ref !== undefined) plugins.push({ ...ref, configDir: dirname(path) });
    }
    Object.assign(mcp, mcpFromConfig(data));
  }

  // V2 loads direct plugin files/directories under .opencode/plugins.
  const pluginDirectory = join(directory, ".opencode", "plugins");
  if (await isDirectory(pluginDirectory)) {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(pluginDirectory, { withFileTypes: true })) {
      if (entry.isDirectory())
        plugins.push({
          target: join(pluginDirectory, entry.name),
          localPath: join(pluginDirectory, entry.name),
        });
      else if (entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name)) {
        plugins.push({
          target: join(pluginDirectory, entry.name),
          localPath: join(pluginDirectory, entry.name),
        });
      }
    }
  }

  return { files, plugins: dedupe(plugins), mcp, warnings };
}

/** Absolute path for a local plugin, or undefined for a package target. */
export function localPluginTarget(ref: PluginRef, directory: string): string | undefined {
  const target = ref.localPath ?? ref.target;
  if (target.startsWith("file://")) {
    try {
      return fileURLToPath(target);
    } catch {
      return undefined;
    }
  }
  if (isAbsolute(target)) return target;
  if (target.startsWith("./") || target.startsWith("../")) {
    return resolve(ref.configDir ?? directory, target);
  }
  return undefined;
}

/** Stable lockfile key: project-relative for local paths, raw target for packages. */
export function pluginAssetKey(ref: PluginRef, directory: string): string {
  const local = localPluginTarget(ref, directory);
  if (local === undefined) return ref.target;
  const realDirectory = realPath(directory);
  const realLocal = realPath(local);
  if (!isInside(realDirectory, realLocal)) return local;
  const path = relative(realDirectory, realLocal).split(sep).join("/");
  return path.length === 0 ? "." : `./${path}`;
}

function dedupe(values: readonly PluginRef[]): PluginRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.configDir ?? ""}\u0000${value.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
