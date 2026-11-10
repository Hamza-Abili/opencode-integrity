import { dirname } from "node:path";
import {
  mcpConfigAsset,
  mcpToolsForServer,
  pluginAsset,
  pluginIDFromRuntime,
  skillAssetFromInfo,
} from "./assets.ts";
import { filterAssets, filterIgnored } from "./audit.ts";
import { loadGlobalMcp, loadProjectConfig } from "./config.ts";
import { audit, createLockfile, readLockfile, writeLockfile } from "./lockfile.ts";
import type { Assets, AuditResult, Lockfile, Options } from "./types.ts";
import { hashDirectory, isInside } from "./util.ts";
import { VERSION as PLUGIN_VERSION } from "./version.ts";

export interface RuntimeContext {
  readonly app?: { readonly version?: string };
  readonly plugin?: { list(): Promise<unknown> };
  readonly mcp?: { list(): Promise<unknown> };
  readonly skill?: { list(): Promise<unknown> };
  readonly tool?: { list(): Promise<readonly unknown[]> };
}

interface RuntimeData {
  readonly plugins: readonly unknown[];
  readonly mcpNames: readonly string[];
  readonly skills: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly version?: string;
}

function dataArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return [];
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readRuntime(ctx: RuntimeContext, include: readonly string[]): Promise<RuntimeData> {
  const plugins =
    include.includes("plugins") && ctx.plugin !== undefined
      ? dataArray(await ctx.plugin.list())
      : [];
  const mcp =
    include.includes("mcp") && ctx.mcp !== undefined ? dataArray(await ctx.mcp.list()) : [];
  const skills =
    include.includes("skills") && ctx.skill !== undefined ? dataArray(await ctx.skill.list()) : [];
  const tools =
    include.includes("mcp") && ctx.tool !== undefined ? ((await ctx.tool.list()) ?? []) : [];
  const mcpNames = mcp
    .map((entry) =>
      typeof object(entry).name === "string" ? (object(entry).name as string) : undefined
    )
    .filter((entry): entry is string => entry !== undefined);
  return { plugins, mcpNames, skills, tools, version: ctx.app?.version };
}

export interface RuntimeSnapshot {
  readonly assets: Assets;
  readonly warnings: readonly string[];
  readonly version?: string;
}

/** Collect the assets OpenCode actually loaded, including live MCP tool descriptors. */
export async function collectRuntime(
  ctx: RuntimeContext,
  directory: string,
  home: string,
  options?: Pick<Options, "include" | "includeGlobal">
): Promise<RuntimeSnapshot> {
  const include = options?.include ?? ["plugins", "mcp", "skills"];
  const runtime = await readRuntime(ctx, include);
  const config = await loadProjectConfig(directory);
  const includeGlobal = options?.includeGlobal === true;
  const projectTargets = new Set(config.plugins.map((ref) => ref.target));
  const warnings = [...config.warnings];
  const plugins: Record<string, Assets["plugins"][string]> = {};

  for (const entry of runtime.plugins) {
    const id = pluginIDFromRuntime(entry);
    if (id === undefined) continue;
    const source = object(object(entry).source);
    const ref =
      source.type === "local" && typeof source.path === "string"
        ? { target: source.path, localPath: source.path }
        : source.type === "package" && typeof source.target === "string"
          ? {
              target: source.target,
              version: typeof source.version === "string" ? source.version : undefined,
            }
          : undefined;
    if (ref === undefined) continue;
    const included =
      includeGlobal ||
      projectTargets.has(ref.target) ||
      (source.type === "local" &&
        typeof source.path === "string" &&
        isInside(directory, source.path));
    if (!included) continue;
    const result = await pluginAsset(id, ref, directory, home, includeGlobal);
    if (result.asset !== undefined) plugins[id] = result.asset;
    if (result.warning !== undefined) warnings.push(result.warning);
  }

  const mcp: Record<string, Assets["mcp"][string]> = {};
  const mcpConfig = includeGlobal ? { ...(await loadGlobalMcp(home)), ...config.mcp } : config.mcp;
  for (const [name, value] of Object.entries(mcpConfig)) {
    const asset = mcpConfigAsset(name, value);
    if (asset === undefined) continue;
    if (runtime.mcpNames.length > 0 && !runtime.mcpNames.includes(name)) continue;
    const tools = mcpToolsForServer(runtime.tools, name);
    mcp[name] = {
      ...asset,
      tools,
      toolsSource: Object.keys(tools).length > 0 ? "runtime" : "none",
    };
  }

  const skills: Record<string, Assets["skills"][string]> = {};
  for (const entry of runtime.skills) {
    const entryPath = typeof object(entry).path === "string" ? (object(entry).path as string) : "";
    if (entryPath.startsWith("skill://")) continue;
    if (!includeGlobal && !isInside(directory, entryPath)) continue;
    const pair = await skillAssetFromInfo(entry, directory);
    if (pair !== undefined) skills[pair[0]] = pair[1];
  }

  return {
    assets: filterAssets({ plugins, mcp, skills }, include),
    warnings,
    version: runtime.version,
  };
}

export interface RuntimeAudit extends AuditResult {
  readonly snapshot: RuntimeSnapshot;
  readonly lockfile?: Lockfile;
}

export async function inspectRuntime(
  ctx: RuntimeContext,
  options: Options,
  directory: string,
  home: string
): Promise<RuntimeAudit> {
  const snapshot = await collectRuntime(ctx, directory, home, options);
  const lockfile = await readLockfile(options.lockfile);
  const filteredLock =
    lockfile === undefined ? undefined : filterAssets(lockfile.assets, options.include);
  const result = audit(filteredLock, snapshot.assets, snapshot.warnings);
  const drift = filterIgnored(result.drift, options.ignore);
  return {
    ...result,
    drift,
    ok: drift.length === 0,
    snapshot,
    lockfile,
  };
}

export async function lockRuntime(
  ctx: RuntimeContext,
  options: Options,
  directory: string,
  home: string
): Promise<{ lockfile: Lockfile; path: string; snapshot: RuntimeSnapshot }> {
  const snapshot = await collectRuntime(ctx, directory, home, options);
  const lockfile = createLockfile(snapshot.assets, snapshot.version, PLUGIN_VERSION);
  await writeLockfile(options.lockfile, lockfile);
  return { lockfile, path: options.lockfile, snapshot };
}

export function changedMCPServers(result: AuditResult): Set<string> {
  return new Set(
    result.drift
      .filter((entry) => entry.asset === "mcp" || entry.asset === "mcp-tool")
      .map((entry) => (entry.asset === "mcp-tool" ? entry.parent : entry.id))
      .filter((entry): entry is string => entry !== undefined)
  );
}

export async function skillDirectoryHashes(
  ctx: RuntimeContext,
  _directory: string
): Promise<Map<string, { hash: string; truncated: boolean }>> {
  const output = new Map<string, { hash: string; truncated: boolean }>();
  if (ctx.skill === undefined) return output;
  for (const entry of dataArray(await ctx.skill.list())) {
    const value = object(entry);
    const id = typeof value.id === "string" ? value.id : undefined;
    const path = typeof value.path === "string" ? value.path : undefined;
    if (id === undefined || path === undefined || path.startsWith("skill://")) continue;
    const hash = await hashDirectory(dirname(path));
    output.set(id, { hash: hash.hash, truncated: hash.truncated });
  }
  return output;
}

export function changedSkills(result: AuditResult): Set<string> {
  return new Set(result.drift.filter((entry) => entry.asset === "skill").map((entry) => entry.id));
}

export function changedPlugins(result: AuditResult): Set<string> {
  return new Set(result.drift.filter((entry) => entry.asset === "plugin").map((entry) => entry.id));
}
