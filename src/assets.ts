import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginRef } from "./config.ts";
import type { McpAsset, McpToolAsset, PluginAsset, SkillAsset } from "./types.ts";
import {
  detectCapabilities,
  detectSuspicious,
  hashDirectory,
  hashObject,
  hashText,
  isDirectory,
  isInside,
  pathExists,
  readJsonFileCapped,
  readTextFileCapped,
  sha256,
  stableStringify,
} from "./util.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretKey(key: string): boolean {
  return /(token|secret|password|api[-_]?key|authorization|cookie|credential)/i.test(key);
}

function redactValue(key: string, value: unknown): unknown {
  return secretKey(key) ? "[redacted]" : value;
}

function redactRecord(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = redactValue(key, entry);
  return output;
}

function redactCommand(command: readonly string[]): string[] {
  return command.map((entry) =>
    entry.replace(/((?:token|secret|password|api[-_]?key)=)[^\s]+/gi, "$1[redacted]")
  );
}

function sanitizeUrl(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "[invalid-url]";
  }
}

function packageJsonPath(root: string): string {
  return join(root, "package.json");
}

async function walkUpToPackage(start: string): Promise<string | undefined> {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (await pathExists(packageJsonPath(current))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** Resolve a package or local plugin reference to its installed root. */
export async function resolvePluginRoot(
  ref: PluginRef,
  directory: string,
  home: string
): Promise<string | undefined> {
  const target = ref.localPath ?? ref.target;
  if (isAbsolute(target) || target.startsWith(".") || target.startsWith("~/")) {
    const expanded = target.startsWith("~")
      ? resolve(home, target.slice(2))
      : resolve(directory, target);
    if (await isDirectory(expanded)) return expanded;
    return await walkUpToPackage(dirname(expanded));
  }
  const direct = join(directory, "node_modules", target);
  if (await isDirectory(direct)) return direct;
  try {
    const require = createRequire(join(directory, "package.json"));
    const entry = require.resolve(target);
    return await walkUpToPackage(dirname(entry));
  } catch {
    return undefined;
  }
}

async function entryText(root: string): Promise<string> {
  const manifest = await readJsonFileCapped<Record<string, unknown>>(packageJsonPath(root));
  const candidates = new Set<string>();
  if (typeof manifest?.main === "string") candidates.add(manifest.main);
  if (typeof manifest?.module === "string") candidates.add(manifest.module);
  const exports = manifest?.exports;
  if (typeof exports === "string") candidates.add(exports);
  else if (isObject(exports)) {
    for (const value of Object.values(exports)) {
      if (typeof value === "string") candidates.add(value);
      else if (isObject(value)) {
        for (const nested of Object.values(value))
          if (typeof nested === "string") candidates.add(nested);
      }
    }
  }
  candidates.add("index.ts");
  candidates.add("index.js");
  for (const candidate of candidates) {
    const path = join(root, candidate);
    if (!isInside(root, path)) continue;
    const real = await realpath(path).catch(() => undefined);
    if (real === undefined || !isInside(root, real)) continue;
    const text = await readTextFileCapped(real);
    if (text !== undefined) return text;
  }
  return "";
}

export async function pluginAsset(
  id: string,
  ref: PluginRef,
  directory: string,
  home: string,
  allowOutside = false
): Promise<{ asset?: PluginAsset; warning?: string }> {
  const root = await resolvePluginRoot(ref, directory, home);
  if (root === undefined) {
    return {
      warning: `${id}: package not installed (${ref.target}); run the package manager first`,
    };
  }
  const realRoot = await realpath(root).catch(() => root);
  if (!allowOutside && !isInside(directory, realRoot)) {
    return { warning: `${id}: local plugin resolves outside the project and was ignored` };
  }
  const manifest = await readJsonFileCapped<Record<string, unknown>>(packageJsonPath(realRoot));
  const version =
    ref.version ?? (typeof manifest?.version === "string" ? manifest.version : undefined);
  const content = await hashDirectory(root);
  const text = await entryText(root);
  return {
    asset: {
      source: ref.target,
      version,
      packageHash: hashObject(manifest ?? {}),
      contentHash: content.hash,
      files: content.files,
      bytes: content.bytes,
      capabilities: detectCapabilities(text),
      truncated: content.truncated,
    },
    warning: content.truncated ? `${id}: hash truncated at 5000 files / 50 MiB` : undefined,
  };
}

async function skillFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") output.push(path);
    }
  }
  await walk(root, 0);
  return output.sort();
}

function skillID(path: string, content: string): string {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  const name = match?.[1]?.match(/^name:\s*["']?([^"'\n]+)["']?/m)?.[1];
  return (name ?? basename(dirname(path))).trim();
}

export async function scanSkills(
  directory: string,
  warnings: string[] = []
): Promise<Record<string, SkillAsset>> {
  const root = join(directory, ".opencode", "skills");
  const output: Record<string, SkillAsset> = {};
  for (const path of await skillFiles(root)) {
    const content = await readTextFileCapped(path);
    if (content === undefined) {
      warnings.push(`${path}: skill too large or unreadable; not hashed`);
      continue;
    }
    const directoryHash = await hashDirectory(dirname(path));
    if (directoryHash.truncated)
      warnings.push(`${path}: skill directory too large to hash completely`);
    output[skillID(path, content)] = {
      path: path.slice(directory.length + 1),
      contentHash: hashText(content),
      directoryHash: directoryHash.hash,
      files: directoryHash.files,
      bytes: directoryHash.bytes,
      truncated: directoryHash.truncated,
      suspicious: detectSuspicious(content),
    };
  }
  return output;
}

export function mcpConfigAsset(_name: string, config: unknown): McpAsset | undefined {
  if (!isObject(config)) return undefined;
  const type =
    typeof config.type === "string"
      ? config.type
      : typeof config.url === "string"
        ? "remote"
        : "local";
  const transport = type === "remote" ? "remote" : "local";
  if (config.disabled === true) return undefined;

  const commandValue = config.command;
  const command = Array.isArray(commandValue)
    ? commandValue.filter((entry): entry is string => typeof entry === "string")
    : typeof commandValue === "string"
      ? commandValue.trim().split(/\s+/)
      : [];
  const environment = redactRecord(config.environment ?? config.env);
  const headers = redactRecord(config.headers);
  const canonical = {
    type,
    command: redactCommand(command),
    cwd: typeof config.cwd === "string" ? config.cwd : undefined,
    url: typeof config.url === "string" ? config.url : undefined,
    environment,
    headers,
    codemode: config.codemode,
  };
  return {
    transport,
    configHash: hashObject(canonical),
    command: command[0] === undefined ? undefined : basename(command[0]),
    url: typeof config.url === "string" ? sanitizeUrl(config.url) : undefined,
    envKeys: Object.keys(environment).sort(),
    toolsSource: "none",
  };
}

function toolCanonical(tool: Record<string, unknown>): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input: tool.input,
    output: tool.output,
    annotations: tool.annotations,
  };
}

export function mcpToolAsset(tool: unknown): McpToolAsset | undefined {
  if (!isObject(tool)) return undefined;
  return {
    descriptorHash: hashObject(toolCanonical(tool)),
    descriptionHash: hashText(typeof tool.description === "string" ? tool.description : ""),
    inputHash: hashObject(tool.input ?? {}),
    suspicious: detectSuspicious(
      `${typeof tool.name === "string" ? tool.name : ""}\n${typeof tool.description === "string" ? tool.description : ""}\n${stableStringify(tool.input ?? {})}`
    ),
  };
}

export function normalizeSkillPath(directory: string, path: string): string {
  return isInside(directory, path) ? relative(directory, path) : path;
}

export async function skillAssetFromInfo(
  skill: unknown,
  directory?: string
): Promise<[string, SkillAsset] | undefined> {
  if (!isObject(skill) || typeof skill.id !== "string" || typeof skill.content !== "string") {
    return undefined;
  }
  if (typeof skill.path === "string" && skill.path.startsWith("skill://")) return undefined;
  if (Buffer.byteLength(skill.content, "utf8") > 2 * 1024 * 1024) return undefined;
  const absolutePath = typeof skill.path === "string" ? skill.path : skill.id;
  const path = directory === undefined ? absolutePath : normalizeSkillPath(directory, absolutePath);
  const directoryHash = await hashDirectory(dirname(absolutePath));
  return [
    skill.id,
    {
      path,
      contentHash: hashText(skill.content),
      directoryHash: directoryHash.hash,
      files: directoryHash.files,
      bytes: directoryHash.bytes,
      truncated: directoryHash.truncated,
      suspicious: detectSuspicious(skill.content),
    },
  ];
}

export function pluginIDFromRuntime(plugin: unknown): string | undefined {
  if (!isObject(plugin)) return undefined;
  if (typeof plugin.id === "string") return plugin.id;
  const source = plugin.source;
  if (!isObject(source)) return undefined;
  if (source.type === "local" && typeof source.path === "string") return source.path;
  if (source.type === "package" && typeof source.target === "string") return source.target;
  return undefined;
}

export function mcpToolsForServer(
  tools: readonly unknown[],
  server: string
): Record<string, McpToolAsset> {
  const output: Record<string, McpToolAsset> = {};
  const normalized = server.replace(/[^A-Za-z0-9_-]/g, "_");
  for (const value of tools) {
    if (!isObject(value)) continue;
    const id =
      typeof value.id === "string" ? value.id : typeof value.name === "string" ? value.name : "";
    if (id.length === 0) continue;
    const namespace = isObject(value.options) ? value.options.namespace : undefined;
    if (
      namespace !== server &&
      !id.startsWith(`${normalized}_`) &&
      !id.startsWith(`mcp__${normalized}__`)
    ) {
      continue;
    }
    const asset = mcpToolAsset(value);
    if (asset !== undefined) output[id] = asset;
  }
  return output;
}

export function stableAssetID(value: string): string {
  return sha256(value).slice(0, 8);
}
