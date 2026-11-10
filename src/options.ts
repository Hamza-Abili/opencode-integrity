import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { AssetKind, Options } from "./types.ts";

const DEFAULTS = {
  lockfile: "opencode.lock.json",
  mode: "warn" as const,
  include: ["plugins", "mcp", "skills"] as readonly AssetKind[],
  ignore: [] as readonly string[],
  includeGlobal: false,
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function expandPath(value: string, directory: string, home = homedir()): string {
  let output = value;
  if (output === "~") output = home;
  else if (output.startsWith("~/")) output = resolve(home, output.slice(2));
  return isAbsolute(output) ? resolve(output) : resolve(directory, output);
}

export function parseOptions(raw: unknown, directory: string, home = homedir()): Options {
  const input = record(raw);
  const include = stringArray(input.include).filter((entry): entry is AssetKind =>
    ["plugins", "mcp", "skills"].includes(entry)
  );
  const lockfile =
    typeof input.lockfile === "string" && input.lockfile.trim().length > 0
      ? expandPath(input.lockfile, directory, home)
      : resolve(directory, DEFAULTS.lockfile);
  const trace =
    typeof input.trace === "string" && input.trace.trim().length > 0
      ? expandPath(input.trace, directory, home)
      : undefined;
  return {
    lockfile,
    mode: input.mode === "enforce" ? "enforce" : "warn",
    include: include.length > 0 ? include : DEFAULTS.include,
    ignore: stringArray(input.ignore),
    includeGlobal: input.includeGlobal === true,
    trace,
  };
}
