import type { RuntimeAudit } from "./runtime.ts";

export const STATUS_TOOL_NAME = "integrity_status";

export const STATUS_TOOL_DESCRIPTION =
  "Report OpenCode plugin, MCP tool and skill integrity against opencode.lock.json, including drift and detected capabilities.";

export const STATUS_TOOL_INPUT = {
  type: "object",
  properties: {
    format: {
      type: "string",
      enum: ["text", "json"],
      description: "text for a readable report, json for machine-readable output",
    },
  },
  additionalProperties: false,
} as const;

export const LOCK_TOOL_NAME = "integrity_lock";

export const LOCK_TOOL_DESCRIPTION =
  "Write or refresh opencode.lock.json from the currently loaded plugins, MCP tool descriptors and skills. Ask the user before calling this.";

export const LOCK_TOOL_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const INTEGRITY_COMMAND = {
  name: "integrity",
  description: "Audit or lock plugins, MCP tools and skills (audit | lock | check)",
} as const;

export async function statusTool(
  refresh: () => Promise<RuntimeAudit>,
  input: unknown
): Promise<{ content: string }> {
  const format =
    typeof input === "object" && input !== null && (input as { format?: unknown }).format === "json"
      ? "json"
      : "text";
  const result = await refresh();
  if (format === "json") return { content: JSON.stringify(result, null, 2) };
  const lines = [
    `opencode-integrity ${result.locked ? "locked" : "unlocked"} — ${result.ok ? "OK" : "DRIFT"}`,
    `assets: ${Object.keys(result.assets.plugins).length} plugin(s), ${Object.keys(result.assets.mcp).length} MCP server(s), ${Object.keys(result.assets.skills).length} skill(s)`,
  ];
  for (const entry of result.drift) lines.push(`${entry.severity}: ${entry.message}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return { content: lines.join("\n") };
}
