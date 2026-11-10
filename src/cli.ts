#!/usr/bin/env node
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import {
  collectStaticAssets,
  describeAudit,
  filterAssets,
  filterIgnored,
  mergeRuntimeTools,
} from "./audit.ts";
import {
  audit,
  createLockfile,
  formatDrift,
  readLockfile,
  severityCounts,
  writeLockfile,
} from "./lockfile.ts";
import { parseOptions } from "./options.ts";
import { generatePolicy } from "./policy.ts";
import { toSarif } from "./sarif.ts";
import { realPath } from "./util.ts";
import { VERSION } from "./version.ts";

type Command = "audit" | "lock" | "check" | "diff" | "policy" | "version";

interface Args {
  command: Command;
  directory: string;
  home: string;
  lockfile?: string;
  format: "text" | "json" | "sarif";
  strict: boolean;
  ignore: string[];
  includeGlobal: boolean;
  denyUnlisted: boolean;
  include?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const output: Args = {
    command: "audit",
    directory: process.cwd(),
    home: homedir(),
    format: "text",
    strict: false,
    ignore: [],
    includeGlobal: false,
    denyUnlisted: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const next = (): string => {
      index += 1;
      return argv[index] ?? "";
    };
    if (["audit", "lock", "check", "diff", "policy", "version"].includes(arg)) {
      output.command = arg as Command;
      continue;
    }
    switch (arg) {
      case "--directory":
      case "-C":
        output.directory = resolve(next());
        break;
      case "--home":
        output.home = resolve(next());
        break;
      case "--lockfile":
        output.lockfile = next();
        break;
      case "--json":
        output.format = "json";
        break;
      case "--format": {
        const value = next();
        output.format = value === "json" || value === "sarif" ? value : "text";
        break;
      }
      case "--strict":
        output.strict = true;
        break;
      case "--ignore":
        output.ignore.push(next());
        break;
      case "--include-global":
        output.includeGlobal = true;
        break;
      case "--deny-unlisted":
        output.denyUnlisted = true;
        break;
      case "--include":
        output.include = next();
        break;
      case "--version":
      case "-v":
        output.command = "version";
        break;
      default:
        break;
    }
  }
  return output;
}

function usage(): string {
  return [
    "opencode-integrity <audit|lock|check|diff|policy|version> [options]",
    "",
    "  audit     show loaded assets and drift (exit 0)",
    "  lock      write opencode.lock.json from the current project",
    "  check     compare against the lockfile (exit 1 on drift)",
    "  diff      print the drift report (exit 0)",
    "  policy    emit OpenCode policy allow statements from the lockfile",
    "",
    "  --directory, -C <path>  project directory (default: cwd)",
    "  --home <path>           home directory (default: $HOME)",
    "  --lockfile <path>       lockfile path (default: <project>/opencode.lock.json)",
    "  --format text|json|sarif",
    "  --strict                audit exits 1 on drift or an unlocked project",
    "  --ignore <pattern>      ignore an asset id (repeatable)",
    "  --include-global        include global MCP config (runtime also plugins/skills)",
    "  --deny-unlisted         policy: prepend deny * so the output is a real allowlist",
    "  --include <classes>     policy: comma-separated plugins,mcp,skills",
  ].join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "version") {
    console.log(`opencode-integrity ${VERSION}`);
    return 0;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return 0;
  }

  const options = parseOptions(
    {
      lockfile: args.lockfile,
      ignore: args.ignore,
      include:
        args.command === "policy" && args.include !== undefined
          ? args.include.split(",")
          : undefined,
      includeGlobal: args.includeGlobal,
      mode: "warn",
    },
    args.directory,
    args.home
  );

  const current = await collectStaticAssets(args.directory, args.home, options);
  const rawPrevious = await readLockfile(options.lockfile);
  const previous =
    rawPrevious === undefined
      ? undefined
      : { ...rawPrevious, assets: filterAssets(rawPrevious.assets, options.include) };

  if (args.command === "lock") {
    const merged = filterAssets(mergeRuntimeTools(current.assets, previous), options.include);
    const lockfile = createLockfile(merged, undefined, VERSION);
    await writeLockfile(options.lockfile, lockfile);
    if (args.format === "json") console.log(JSON.stringify(lockfile, null, 2));
    else {
      console.log(`locked ${options.lockfile}`);
      console.log(
        `assets: ${Object.keys(merged.plugins).length} plugin(s), ${Object.keys(merged.mcp).length} MCP server(s), ${Object.keys(merged.skills).length} skill(s)`
      );
      const missing = Object.entries(merged.mcp)
        .filter(([, asset]) => Object.keys(asset.tools ?? {}).length === 0)
        .map(([name]) => name);
      if (missing.length > 0) {
        console.log(
          `warning: no runtime MCP tool descriptors for ${missing.join(", ")}; run /integrity lock inside OpenCode to pin tool definitions.`
        );
      }
    }
    return 0;
  }

  if (args.command === "policy") {
    const assets = previous?.assets ?? current.assets;
    console.log(
      JSON.stringify(
        generatePolicy(assets, {
          denyUnlisted: args.denyUnlisted,
          include: options.include,
          resolvePlugin: (source) => {
            const targets = current.policyTargets.get(source);
            if (targets !== undefined) return targets;
            if (source !== "." && !source.startsWith("./")) return source;
            const target = resolve(args.directory, source);
            const real = realPath(target);
            return real === target ? [target] : [target, real];
          },
        }),
        null,
        2
      )
    );
    return 0;
  }

  const merged = filterAssets(mergeRuntimeTools(current.assets, previous), options.include);
  const result = audit(previous?.assets, merged, current.warnings, false);
  const drift = filterIgnored(result.drift, options.ignore);
  const final = { ...result, drift, ok: drift.length === 0 };

  if (args.format === "sarif") {
    const uri = relative(args.directory, options.lockfile) || options.lockfile;
    console.log(JSON.stringify(toSarif(drift, VERSION, uri, !final.locked), null, 2));
  } else if (args.format === "json") {
    console.log(JSON.stringify(final, null, 2));
  } else if (args.command === "diff") {
    console.log(drift.length === 0 ? "no drift" : formatDrift(drift));
  } else {
    console.log(describeAudit(final, args.command === "audit"));
    if (final.locked && !final.ok) {
      const counts = severityCounts(drift);
      console.log(
        `summary: ${counts.high ?? 0} high, ${counts.medium ?? 0} medium, ${counts.low ?? 0} low`
      );
    }
  }

  if (args.command === "check") return final.ok && final.locked ? 0 : 1;
  if (args.command === "audit" && args.strict) return final.ok && final.locked ? 0 : 1;
  return 0;
}

process.exitCode = await main();
