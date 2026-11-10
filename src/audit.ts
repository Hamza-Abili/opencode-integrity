import { mcpConfigAsset, pluginAsset, scanSkills } from "./assets.ts";
import { loadGlobalMcp, loadProjectConfig } from "./config.ts";
import { audit, formatDrift, severityCounts } from "./lockfile.ts";
import type { AssetKind, Assets, AuditResult, DriftEntry, Lockfile, Options } from "./types.ts";
import { ignored } from "./util.ts";

export interface StaticAudit {
  readonly assets: Assets;
  readonly warnings: readonly string[];
  readonly files: readonly string[];
}

export function filterAssets(assets: Assets, include: readonly AssetKind[]): Assets {
  return {
    plugins: include.includes("plugins") ? assets.plugins : {},
    mcp: include.includes("mcp") ? assets.mcp : {},
    skills: include.includes("skills") ? assets.skills : {},
  };
}

export async function collectStaticAssets(
  directory: string,
  home: string,
  options?: Pick<Options, "include" | "includeGlobal">
): Promise<StaticAudit> {
  const config = await loadProjectConfig(directory);
  const warnings = [...config.warnings];
  const plugins: Record<string, Assets["plugins"][string]> = {};
  for (const ref of config.plugins) {
    const id = ref.target;
    const result = await pluginAsset(id, ref, directory, home);
    if (result.asset !== undefined) plugins[id] = result.asset;
    if (result.warning !== undefined) warnings.push(result.warning);
  }
  const mcp: Record<string, Assets["mcp"][string]> = {};
  const mcpConfig =
    options?.includeGlobal === true
      ? { ...(await loadGlobalMcp(home)), ...config.mcp }
      : config.mcp;
  for (const [name, value] of Object.entries(mcpConfig)) {
    const asset = mcpConfigAsset(name, value);
    if (asset !== undefined) mcp[name] = asset;
  }
  const include = options?.include ?? ["plugins", "mcp", "skills"];
  return {
    assets: filterAssets({ plugins, mcp, skills: await scanSkills(directory) }, include),
    warnings,
    files: config.files,
  };
}

/**
 * Keep runtime-collected MCP tool descriptors when the server configuration did
 * not change. A CLI lock must not silently erase the tool fingerprints that
 * only OpenCode can observe.
 */
export function mergeRuntimeTools(current: Assets, previous?: Lockfile): Assets {
  if (previous === undefined) return current;
  const mcp: Record<string, Assets["mcp"][string]> = {};
  for (const [name, asset] of Object.entries(current.mcp)) {
    const old = previous.assets.mcp[name];
    mcp[name] =
      old !== undefined && old.configHash === asset.configHash && old.tools !== undefined
        ? { ...asset, tools: old.tools, toolsSource: old.toolsSource ?? "runtime" }
        : asset;
  }
  return { ...current, mcp };
}

export function filterIgnored(
  drift: readonly DriftEntry[],
  patterns: readonly string[]
): DriftEntry[] {
  if (patterns.length === 0) return [...drift];
  return drift.filter((entry) => {
    const id = entry.asset === "mcp-tool" ? `${entry.parent}:${entry.id}` : entry.id;
    return !ignored(id, patterns) && !ignored(`${entry.asset}:${id}`, patterns);
  });
}

export function buildAudit(
  current: Assets,
  previous: Lockfile | undefined,
  warnings: readonly string[]
): AuditResult {
  return audit(previous?.assets, current, warnings);
}

export function describeAudit(result: AuditResult, verbose = false): string {
  const lines: string[] = [];
  if (!result.locked) {
    lines.push("No lockfile found. This is an audit only.");
  } else if (result.ok) {
    lines.push("Integrity OK: no drift from opencode.lock.json.");
  } else {
    const counts = severityCounts(result.drift);
    lines.push(
      `Drift detected: ${result.drift.length} change(s) — ${counts.high ?? 0} high, ${counts.medium ?? 0} medium, ${counts.low ?? 0} low.`
    );
    lines.push(formatDrift(result.drift));
  }
  const pluginCount = Object.keys(result.assets.plugins).length;
  const mcpCount = Object.keys(result.assets.mcp).length;
  const toolCount = Object.values(result.assets.mcp).reduce(
    (sum, asset) => sum + Object.keys(asset.tools ?? {}).length,
    0
  );
  const skillCount = Object.keys(result.assets.skills).length;
  lines.push(
    `Assets: ${pluginCount} plugin(s), ${mcpCount} MCP server(s), ${toolCount} MCP tool(s), ${skillCount} skill(s).`
  );
  if (verbose) {
    for (const [id, asset] of Object.entries(result.assets.plugins)) {
      lines.push(
        `  plugin ${id}${asset.version === undefined ? "" : `@${asset.version}`} ${asset.files ?? 0} files [${(asset.capabilities ?? []).join(", ") || "no detected capabilities"}]`
      );
    }
    for (const [id, asset] of Object.entries(result.assets.mcp)) {
      lines.push(`  mcp ${id} (${asset.transport}) ${asset.command ?? asset.url ?? ""}`);
    }
    for (const [id, asset] of Object.entries(result.assets.skills)) {
      lines.push(
        `  skill ${id} ${asset.bytes} bytes${(asset.suspicious ?? []).length > 0 ? ` suspicious: ${(asset.suspicious ?? []).join(", ")}` : ""}`
      );
    }
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}
