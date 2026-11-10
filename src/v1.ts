import { homedir } from "node:os";
import { collectStaticAssets, describeAudit, filterAssets } from "./audit.ts";
import { audit, readLockfile } from "./lockfile.ts";
import { parseOptions } from "./options.ts";
import { changedMCPServers, changedSkills } from "./runtime.ts";
import type { AdapterEnvironment, AuditResult, Options } from "./types.ts";

type Json = Record<string, unknown>;

interface V1Hooks {
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown }
  ) => Promise<void>;
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string },
    output: { system: string[] }
  ) => Promise<void>;
  event?: (input: { event: { type: string; properties?: Json } }) => Promise<void>;
  dispose?: () => Promise<void>;
}

function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function serverForTool(tool: string, servers: readonly string[]): string | undefined {
  return [...servers]
    .sort((a, b) => b.length - a.length)
    .find((server) => {
      const normalized = server.replace(/[^A-Za-z0-9_-]/g, "_");
      return tool.startsWith(`${normalized}_`) || tool.startsWith(`mcp__${normalized}__`);
    });
}

function skillName(input: unknown): string | undefined {
  const value = object(input);
  return typeof value.name === "string"
    ? value.name
    : typeof value.id === "string"
      ? value.id
      : undefined;
}

export async function server(
  input: unknown,
  rawOptions?: unknown,
  environment: AdapterEnvironment = {}
): Promise<V1Hooks> {
  const plugin = object(input);
  const directory =
    typeof plugin.directory === "string"
      ? plugin.directory
      : typeof plugin.worktree === "string"
        ? plugin.worktree
        : process.cwd();
  const home = environment.home ?? homedir();
  const options: Options = parseOptions(rawOptions, directory, home);
  const staticAssets = await collectStaticAssets(directory, home, options);
  const lock = await readLockfile(options.lockfile);
  const result: AuditResult = audit(
    lock === undefined ? undefined : filterAssets(lock.assets, options.include),
    staticAssets.assets,
    staticAssets.warnings,
    false
  );
  const warned = new Set<string>();

  const log = (message: string): void => console.error(`[opencode-integrity] ${message}`);

  if (!result.locked) {
    log(`no lockfile at ${options.lockfile}; static audit only (V1)`);
  } else if (!result.ok) {
    log(`drift detected in enforce=${options.mode === "enforce"} mode:\n${describeAudit(result)}`);
  }

  const hooks: V1Hooks = {
    "tool.execute.before": async (event, output) => {
      if (options.mode !== "enforce" || !result.locked) return;
      const servers = changedMCPServers(result);
      const server = serverForTool(event.tool, Object.keys(result.assets.mcp));
      if (server !== undefined && servers.has(server)) {
        throw new Error(`MCP server ${server} changed since opencode.lock.json; review and relock`);
      }
      if (event.tool === "skill") {
        const name = skillName(output.args);
        if (name !== undefined && changedSkills(result).has(name)) {
          throw new Error(`skill ${name} changed since opencode.lock.json; review and relock`);
        }
      }
    },

    "experimental.chat.system.transform": async (event, output) => {
      const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
      if (sessionID.length === 0 || warned.has(sessionID)) return;
      warned.add(sessionID);
      if (!result.locked) {
        output.system.push(
          `opencode-integrity: no lockfile at ${options.lockfile}. Audit only on V1; run the CLI to create one.`
        );
        return;
      }
      if (!result.ok) {
        output.system.push(`opencode-integrity: drift detected.\n${describeAudit(result, false)}`);
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        if (!result.locked) log("session started without a lockfile");
        else if (!result.ok) log(`session started with ${result.drift.length} drift entries`);
      }
    },

    dispose: async () => undefined,
  };

  return hooks;
}
