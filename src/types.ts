export const SCHEMA_VERSION = 1 as const;

export type AssetKind = "plugins" | "mcp" | "skills";

export interface PluginAsset {
  readonly source: string;
  readonly version?: string;
  readonly contentHash?: string;
  readonly packageHash?: string;
  readonly files?: number;
  readonly bytes?: number;
  readonly capabilities?: readonly string[];
  readonly truncated?: boolean;
}

export interface McpToolAsset {
  readonly descriptorHash: string;
  readonly descriptionHash: string;
  readonly inputHash: string;
  readonly suspicious?: readonly string[];
}

export interface McpAsset {
  readonly transport: "local" | "remote";
  readonly configHash: string;
  readonly command?: string;
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly tools?: Readonly<Record<string, McpToolAsset>>;
  readonly toolsSource?: "runtime" | "none";
}

export interface SkillAsset {
  readonly path: string;
  readonly contentHash: string;
  readonly directoryHash?: string;
  readonly files?: number;
  readonly bytes: number;
  readonly truncated?: boolean;
  readonly suspicious?: readonly string[];
}

export interface Assets {
  readonly plugins: Readonly<Record<string, PluginAsset>>;
  readonly mcp: Readonly<Record<string, McpAsset>>;
  readonly skills: Readonly<Record<string, SkillAsset>>;
}

export interface Lockfile {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly generatedBy: string;
  readonly opencode?: string;
  readonly assets: Assets;
}

export type Change = "added" | "removed" | "changed";
export type Severity = "high" | "medium" | "low";

export interface DriftEntry {
  readonly asset: "plugin" | "mcp" | "mcp-tool" | "skill";
  readonly id: string;
  readonly parent?: string;
  readonly change: Change;
  readonly field?: string;
  readonly severity: Severity;
  readonly message: string;
}

export interface AuditResult {
  readonly locked: boolean;
  readonly ok: boolean;
  readonly drift: readonly DriftEntry[];
  readonly warnings: readonly string[];
  readonly assets: Assets;
  readonly lockedAssets?: Assets;
}

export interface Options {
  readonly lockfile: string;
  readonly mode: "warn" | "enforce";
  readonly include: readonly AssetKind[];
  readonly ignore: readonly string[];
  readonly includeGlobal: boolean;
  readonly trace?: string;
}

export interface Host {
  readonly directory: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version?: string;
  readonly status?: (message: string) => void;
}

/** Test seam: adapters fall back to the real home directory. */
export interface AdapterEnvironment {
  readonly home?: string;
}

export function emptyAssets(): Assets {
  return { plugins: {}, mcp: {}, skills: {} };
}
