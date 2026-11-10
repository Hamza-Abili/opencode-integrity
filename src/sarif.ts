import type { DriftEntry } from "./types.ts";

const RULES = [
  "plugin-changed",
  "plugin-added",
  "plugin-removed",
  "mcp-changed",
  "mcp-added",
  "mcp-removed",
  "mcp-tool-changed",
  "mcp-tool-added",
  "mcp-tool-removed",
  "skill-changed",
  "skill-added",
  "skill-removed",
  "lockfile-missing",
] as const;

function ruleID(entry: DriftEntry): string {
  const suffix =
    entry.asset === "mcp-tool" ? `mcp-tool-${entry.change}` : `${entry.asset}-${entry.change}`;
  return `integrity/${RULES.includes(suffix as (typeof RULES)[number]) ? suffix : "plugin-changed"}`;
}

/** SARIF 2.1.0 for GitHub code scanning and other CI dashboards. */
export function toSarif(
  drift: readonly DriftEntry[],
  version: string,
  lockfile: string,
  missingLockfile = false
): unknown {
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "opencode-integrity",
            informationUri: "https://github.com/Hamza-Abili/opencode-integrity",
            version,
            rules: RULES.map((id) => ({ id: `integrity/${id}` })),
          },
        },
        results: [
          ...(missingLockfile
            ? [
                {
                  ruleId: "integrity/lockfile-missing",
                  level: "error",
                  message: { text: `no lockfile at ${lockfile}; run integrity lock` },
                  locations: [{ physicalLocation: { artifactLocation: { uri: lockfile } } }],
                },
              ]
            : []),
          ...drift.map((entry) => ({
            ruleId: ruleID(entry),
            level:
              entry.severity === "high"
                ? "error"
                : entry.severity === "medium"
                  ? "warning"
                  : "note",
            message: { text: entry.message },
            locations: [{ physicalLocation: { artifactLocation: { uri: lockfile } } }],
          })),
        ],
      },
    ],
  };
}
