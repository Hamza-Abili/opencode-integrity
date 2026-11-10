import type { Assets, AuditResult, DriftEntry, Lockfile } from "./types.ts";
import { SCHEMA_VERSION } from "./types.ts";
import { readJsonFile, stableStringify, writeFileAtomic } from "./util.ts";

function sortRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function sortAssets(assets: Assets): Assets {
  return {
    plugins: sortRecord(assets.plugins),
    mcp: Object.fromEntries(
      Object.entries(assets.mcp)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, asset]) => [
          name,
          { ...asset, tools: asset.tools === undefined ? undefined : sortRecord(asset.tools) },
        ])
    ),
    skills: sortRecord(assets.skills),
  };
}

export function createLockfile(assets: Assets, opencode?: string, version = "0.1.0"): Lockfile {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: `opencode-integrity@${version}`,
    opencode,
    assets: sortAssets(assets),
  };
}

export async function readLockfile(path: string): Promise<Lockfile | undefined> {
  const raw = await readJsonFile<unknown>(path);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== SCHEMA_VERSION || typeof record.assets !== "object")
    return undefined;
  const assets = record.assets as Record<string, unknown>;
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedBy: typeof record.generatedBy === "string" ? record.generatedBy : "unknown",
    opencode: typeof record.opencode === "string" ? record.opencode : undefined,
    assets: {
      plugins: isRecord(assets.plugins) ? (assets.plugins as Assets["plugins"]) : {},
      mcp: isRecord(assets.mcp) ? (assets.mcp as Assets["mcp"]) : {},
      skills: isRecord(assets.skills) ? (assets.skills as Assets["skills"]) : {},
    },
  };
}

export async function writeLockfile(path: string, lockfile: Lockfile): Promise<void> {
  const canonical = JSON.parse(stableStringify(lockfile)) as Lockfile;
  await writeFileAtomic(path, `${JSON.stringify(canonical, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function diffAssets(locked: Assets, current: Assets, compareTools = true): DriftEntry[] {
  const drift: DriftEntry[] = [];

  for (const [id, asset] of Object.entries(current.plugins)) {
    const before = locked.plugins[id];
    if (before === undefined) {
      drift.push({
        asset: "plugin",
        id,
        change: "added",
        severity: "high",
        message: `new plugin ${id}`,
      });
      continue;
    }
    if (before.truncated === true || asset.truncated === true) {
      drift.push({
        asset: "plugin",
        id,
        change: "changed",
        field: "hash incomplete",
        severity: "high",
        message: `plugin ${id}: package too large to hash completely; reduce it or inspect manually`,
      });
      continue;
    }
    if (before.contentHash !== asset.contentHash || before.packageHash !== asset.packageHash) {
      const fields: string[] = [];
      if (before.version !== asset.version)
        fields.push(`version ${before.version ?? "?"} -> ${asset.version ?? "?"}`);
      if (before.contentHash !== asset.contentHash) fields.push("package content changed");
      drift.push({
        asset: "plugin",
        id,
        change: "changed",
        field: fields.join(", "),
        severity: "high",
        message: `plugin ${id}: ${fields.join(", ") || "content changed"}`,
      });
    }
    const added = (asset.capabilities ?? []).filter(
      (capability) => !(before.capabilities ?? []).includes(capability)
    );
    if (added.length > 0) {
      drift.push({
        asset: "plugin",
        id,
        change: "changed",
        field: `capabilities +${added.join(",")}`,
        severity: "high",
        message: `plugin ${id}: new capabilities ${added.join(", ")}`,
      });
    }
  }
  for (const id of Object.keys(locked.plugins)) {
    if (current.plugins[id] === undefined) {
      drift.push({
        asset: "plugin",
        id,
        change: "removed",
        severity: "low",
        message: `plugin ${id} removed`,
      });
    }
  }

  for (const [id, asset] of Object.entries(current.mcp)) {
    const before = locked.mcp[id];
    if (before === undefined) {
      drift.push({
        asset: "mcp",
        id,
        change: "added",
        severity: "high",
        message: `new MCP server ${id}`,
      });
      continue;
    }
    if (before.configHash !== asset.configHash) {
      drift.push({
        asset: "mcp",
        id,
        change: "changed",
        field: "config",
        severity: "medium",
        message: `MCP server ${id}: command, URL or environment changed`,
      });
    }
    if (!compareTools) continue;
    const beforeTools = before.tools ?? {};
    const currentTools = asset.tools ?? {};
    for (const [tool, toolAsset] of Object.entries(currentTools)) {
      const previous = beforeTools[tool];
      if (previous === undefined) {
        drift.push({
          asset: "mcp-tool",
          id: tool,
          parent: id,
          change: "added",
          severity: "high",
          message: `MCP server ${id}: new tool ${tool}${(toolAsset.suspicious ?? []).length > 0 ? ` [suspicious: ${(toolAsset.suspicious ?? []).join(", ")}]` : ""}`,
        });
        continue;
      }
      const fields: string[] = [];
      if (previous.descriptionHash !== toolAsset.descriptionHash) fields.push("description");
      if (previous.inputHash !== toolAsset.inputHash) fields.push("input schema");
      if (fields.length > 0 || previous.descriptorHash !== toolAsset.descriptorHash) {
        drift.push({
          asset: "mcp-tool",
          id: tool,
          parent: id,
          change: "changed",
          field: fields.join(", ") || "descriptor",
          severity: "high",
          message: `MCP server ${id}: tool ${tool} changed (${fields.join(", ") || "descriptor"})${(toolAsset.suspicious ?? []).length > 0 ? ` [suspicious: ${(toolAsset.suspicious ?? []).join(", ")}]` : ""}`,
        });
      }
    }
    for (const tool of Object.keys(beforeTools)) {
      if (currentTools[tool] === undefined) {
        drift.push({
          asset: "mcp-tool",
          id: tool,
          parent: id,
          change: "removed",
          severity: "medium",
          message: `MCP server ${id}: tool ${tool} removed`,
        });
      }
    }
  }
  for (const id of Object.keys(locked.mcp)) {
    if (current.mcp[id] === undefined) {
      drift.push({
        asset: "mcp",
        id,
        change: "removed",
        severity: "medium",
        message: `MCP server ${id} removed`,
      });
    }
  }

  for (const [id, asset] of Object.entries(current.skills)) {
    const before = locked.skills[id];
    if (before === undefined) {
      drift.push({
        asset: "skill",
        id,
        change: "added",
        severity: "high",
        message: `new skill ${id}`,
      });
      continue;
    }
    if (before.truncated === true || asset.truncated === true) {
      drift.push({
        asset: "skill",
        id,
        change: "changed",
        field: "hash incomplete",
        severity: "high",
        message: `skill ${id}: directory too large to hash completely; inspect manually`,
      });
      continue;
    }
    if (
      before.contentHash !== asset.contentHash ||
      before.path !== asset.path ||
      before.directoryHash !== asset.directoryHash
    ) {
      const field =
        before.contentHash !== asset.contentHash
          ? "content"
          : before.path !== asset.path
            ? "path"
            : "files";
      drift.push({
        asset: "skill",
        id,
        change: "changed",
        field,
        severity: "high",
        message: `skill ${id}: ${field} changed${(asset.suspicious ?? []).length > 0 ? ` [suspicious: ${(asset.suspicious ?? []).join(", ")}]` : ""}`,
      });
    }
  }
  for (const id of Object.keys(locked.skills)) {
    if (current.skills[id] === undefined) {
      drift.push({
        asset: "skill",
        id,
        change: "removed",
        severity: "low",
        message: `skill ${id} removed`,
      });
    }
  }

  return drift.sort((a, b) => a.asset.localeCompare(b.asset) || a.id.localeCompare(b.id));
}

export function audit(
  locked: Assets | undefined,
  current: Assets,
  warnings: readonly string[],
  compareTools = true
): AuditResult {
  if (locked === undefined) {
    return { locked: false, ok: true, drift: [], warnings, assets: current };
  }
  const drift = diffAssets(locked, current, compareTools);
  return {
    locked: true,
    ok: drift.length === 0,
    drift,
    warnings,
    assets: current,
    lockedAssets: locked,
  };
}

export function formatDrift(drift: readonly DriftEntry[]): string {
  if (drift.length === 0) return "no drift";
  return drift
    .map((entry) => {
      const icon = entry.change === "added" ? "+" : entry.change === "removed" ? "-" : "~";
      return `${icon} [${entry.severity}] ${entry.message}`;
    })
    .join("\n");
}

export function severityCounts(drift: readonly DriftEntry[]): Record<string, number> {
  const output: Record<string, number> = { high: 0, medium: 0, low: 0 };
  for (const entry of drift) output[entry.severity] = (output[entry.severity] ?? 0) + 1;
  return output;
}
