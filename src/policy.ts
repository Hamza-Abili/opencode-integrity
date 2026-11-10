import { isAbsolute } from "node:path";
import type { AssetKind, Assets } from "./types.ts";

export interface PolicyStatement {
  readonly action: "mcp.use" | "skill.use" | "plugin.use";
  readonly resource: string;
  readonly effect: "allow" | "deny";
}

export interface PolicyOptions {
  /** Start each included class with `deny *`, producing a real allowlist. */
  readonly denyUnlisted?: boolean;
  /** Asset classes to emit. Defaults to all three. */
  readonly include?: readonly AssetKind[];
  /** Resolve a locked plugin source to one or more targets OpenCode may check. */
  readonly resolvePlugin?: (source: string) => string | readonly string[];
}

/** The runtime plugin must survive its own `plugin.use deny *` statement. */
export const SELF_PLUGIN = "@hamzaabili/opencode-integrity";

/** OpenCode strips npm versions from plugin targets before matching policies. */
export function pluginPolicyResource(source: string): string {
  if (isAbsolute(source) || source.startsWith(".")) return source;
  const separator = source.lastIndexOf("@");
  return separator <= 0 ? source : source.slice(0, separator);
}

/**
 * Generate OpenCode policies from the lockfile.
 *
 * Policies default to allow when nothing matches, so allow statements alone do
 * not restrict anything. `denyUnlisted` prepends `deny *` for each included
 * class, which turns the output into an actual allowlist.
 */
export function generatePolicy(
  assets: Assets,
  options: PolicyOptions = {}
): { policies: PolicyStatement[] } {
  const include = options.include ?? ["mcp", "skills", "plugins"];
  const policies: PolicyStatement[] = [];
  const mcp = Object.keys(assets.mcp).sort();
  const skills = Object.keys(assets.skills).sort();
  const plugins = [
    ...new Set(
      Object.values(assets.plugins).flatMap((asset) => {
        const resolved = options.resolvePlugin?.(asset.source) ?? asset.source;
        return (typeof resolved === "string" ? [resolved] : resolved).map(pluginPolicyResource);
      })
    ),
  ].sort();

  for (const kind of include) {
    if (kind === "mcp") {
      if (options.denyUnlisted === true) {
        policies.push({ action: "mcp.use", resource: "*", effect: "deny" });
      }
      for (const id of mcp) {
        policies.push({ action: "mcp.use", resource: id, effect: "allow" });
      }
    }
    if (kind === "skills") {
      if (options.denyUnlisted === true) {
        policies.push({ action: "skill.use", resource: "*", effect: "deny" });
      }
      for (const id of skills) {
        policies.push({ action: "skill.use", resource: id, effect: "allow" });
      }
    }
    if (kind === "plugins") {
      if (options.denyUnlisted === true) {
        policies.push({ action: "plugin.use", resource: "*", effect: "deny" });
        policies.push({ action: "plugin.use", resource: SELF_PLUGIN, effect: "allow" });
      }
      for (const id of plugins) {
        if (id === SELF_PLUGIN) continue;
        policies.push({ action: "plugin.use", resource: id, effect: "allow" });
      }
    }
  }
  return { policies };
}
