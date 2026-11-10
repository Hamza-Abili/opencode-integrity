import type { Assets } from "./types.ts";

export interface PolicyStatement {
  readonly action: "mcp.use" | "skill.use" | "plugin.use";
  readonly resource: string;
  readonly effect: "allow";
}

/** Generate a native OpenCode allowlist from the locked asset names. */
export function generatePolicy(assets: Assets): { policies: PolicyStatement[] } {
  const policies: PolicyStatement[] = [];
  for (const id of Object.keys(assets.mcp).sort()) {
    policies.push({ action: "mcp.use", resource: id, effect: "allow" });
  }
  for (const id of Object.keys(assets.skills).sort()) {
    policies.push({ action: "skill.use", resource: id, effect: "allow" });
  }
  for (const asset of Object.values(assets.plugins)) {
    const resource = asset.source.startsWith(".")
      ? asset.source
      : asset.source.split("@").slice(0, 2).join("@");
    policies.push({ action: "plugin.use", resource, effect: "allow" });
  }
  return { policies };
}
