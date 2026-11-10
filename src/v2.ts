import { homedir } from "node:os";
import { mcpConfigAsset, normalizeSkillPath } from "./assets.ts";
import { describeAudit } from "./audit.ts";
import { readLockfile } from "./lockfile.ts";
import { parseOptions } from "./options.ts";
import {
  changedMCPServers,
  changedSkills,
  inspectRuntime,
  lockRuntime,
  type RuntimeAudit,
  type RuntimeContext,
  skillDirectoryHashes,
} from "./runtime.ts";
import {
  INTEGRITY_COMMAND,
  LOCK_TOOL_DESCRIPTION,
  LOCK_TOOL_INPUT,
  LOCK_TOOL_NAME,
  STATUS_TOOL_DESCRIPTION,
  STATUS_TOOL_INPUT,
  STATUS_TOOL_NAME,
  statusTool,
} from "./tool.ts";
import { hashText } from "./util.ts";
import { VERSION } from "./version.ts";

type Json = Record<string, unknown>;
interface Disposable {
  dispose(): Promise<void> | void;
}

interface V2Context extends RuntimeContext {
  readonly location?: { readonly directory?: string };
  readonly options?: unknown;
  readonly app?: { readonly version?: string };
  readonly permission?: {
    assert(input: Json): Promise<void>;
    hook?(name: "evaluate", callback: (event: Json) => Promise<void> | void): Promise<Disposable>;
  };
  readonly mcp?: {
    list(): Promise<unknown>;
    transform(
      callback: (editor: {
        list(): readonly [string, Json][];
        update(name: string, update: (value: Json) => void): void;
      }) => void
    ): Promise<Disposable>;
  };
  readonly skill?: {
    list(): Promise<unknown>;
    transform(
      callback: (editor: { list(): readonly Json[]; remove(id: string): void }) => void
    ): Promise<Disposable>;
  };
  readonly command?: {
    transform(callback: (editor: { add(command: Json): void }) => void): Promise<Disposable>;
  };
  readonly tool?: {
    list(): Promise<readonly unknown[]>;
    transform(callback: (editor: { add(tool: Json): void }) => void): Promise<Disposable>;
    hook?(name: string, callback: (event: Json) => Promise<void> | void): Promise<Disposable>;
  };
  readonly session: {
    hook(name: string, callback: (event: Json) => Promise<void> | void): Promise<Disposable>;
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
    interrupt(input: { sessionID: string; resume?: boolean }): Promise<unknown>;
  };
}

function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function debug(...values: unknown[]): void {
  if (process.env.OPENCODE_INTEGRITY_DEBUG === "1") {
    console.error("[opencode-integrity:debug]", ...values);
  }
}

async function toolError(message: string): Promise<Error> {
  try {
    const specifier = "@opencode/plugin";
    const module = (await import(specifier)) as {
      Tool?: { Error?: new (input: { message: string }) => Error };
    };
    if (module.Tool?.Error !== undefined) return new module.Tool.Error({ message });
  } catch {
    // V1 or authoring package unavailable.
  }
  const error = new Error(message);
  error.name = "Tool.Error";
  return error;
}

function serverForTool(tool: string, servers: readonly string[]): string | undefined {
  return [...servers]
    .sort((a, b) => b.length - a.length)
    .find((server) => {
      const normalized = server.replace(/[^A-Za-z0-9_-]/g, "_");
      return tool.startsWith(`${normalized}_`) || tool.startsWith(`mcp__${normalized}__`);
    });
}

function toolNameFromInput(input: unknown): string | undefined {
  const value = object(input);
  return typeof value.name === "string"
    ? value.name
    : typeof value.id === "string"
      ? value.id
      : undefined;
}

export async function setup(
  input: unknown,
  environment: { home?: string } = {}
): Promise<() => Promise<void>> {
  const ctx = input as V2Context;
  const directory = ctx.location?.directory ?? process.cwd();
  const home = environment.home ?? homedir();
  const options = parseOptions(ctx.options, directory, home);
  const disposables: Disposable[] = [];
  const canForceAsk = ctx.permission?.hook !== undefined;
  if (ctx.permission?.hook !== undefined) {
    disposables.push(
      await ctx.permission.hook("evaluate", (event) => {
        if (event.action === "integrity_lock") event.effect = "ask";
      })
    );
  }
  let cached: RuntimeAudit | undefined;
  let enforcement: RuntimeAudit | undefined;
  let warnedSession: string | undefined;

  const refresh = async (): Promise<RuntimeAudit> => {
    cached = await inspectRuntime(ctx, options, directory, home);
    return cached;
  };

  // Enforce MCP configuration drift before a server is used.
  if (
    options.mode === "enforce" &&
    options.include.includes("mcp") &&
    ctx.mcp?.transform !== undefined
  ) {
    const lock = await readLockfile(options.lockfile);
    if (lock !== undefined) {
      disposables.push(
        await ctx.mcp.transform((editor) => {
          for (const [name, config] of editor.list()) {
            const current = mcpConfigAsset(name, config);
            const previous = lock.assets.mcp[name];
            if (current === undefined) continue;
            if (previous === undefined || current.configHash !== previous.configHash) {
              editor.update(name, (value) => {
                value.disabled = true;
              });
            }
          }
        })
      );
    }
  }

  // Enforce changed skills by removing them from the advertised set.
  if (
    options.mode === "enforce" &&
    options.include.includes("skills") &&
    ctx.skill?.transform !== undefined
  ) {
    const lock = await readLockfile(options.lockfile);
    const skillHashes = await skillDirectoryHashes(ctx, directory);
    if (lock !== undefined) {
      disposables.push(
        await ctx.skill.transform((editor) => {
          for (const skill of editor.list()) {
            const id = typeof skill.id === "string" ? skill.id : undefined;
            if (id === undefined) continue;
            const absolutePath = typeof skill.path === "string" ? skill.path : "";
            if (absolutePath.startsWith("skill://")) continue;
            const path = normalizeSkillPath(directory, absolutePath);
            const previous = lock.assets.skills[id];
            const content = typeof skill.content === "string" ? skill.content : "";
            const directoryHash = skillHashes.get(id);
            if (
              previous === undefined ||
              previous.contentHash !== hashText(content) ||
              previous.path !== path ||
              directoryHash?.truncated === true ||
              (directoryHash !== undefined && previous.directoryHash !== directoryHash.hash)
            ) {
              editor.remove(id);
            }
          }
        })
      );
    }
  }

  // First context: compute drift and inject a report once per session.
  disposables.push(
    await ctx.session.hook("context", async (event) => {
      const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
      if (sessionID.length === 0) return;
      if (cached === undefined) await refresh();
      if (cached === undefined || warnedSession === sessionID) return;
      warnedSession = sessionID;
      if (!cached.locked) {
        const text = `opencode-integrity: no lockfile at ${options.lockfile}. Run /integrity lock to pin plugins, MCP tools and skills.`;
        if (Array.isArray(event.system)) event.system.push({ type: "text", text });
        return;
      }
      if (cached.drift.length === 0) return;
      const text = `opencode-integrity: drift detected (${options.mode}).\n${describeAudit(cached, false)}`;
      if (Array.isArray(event.system)) event.system.push({ type: "text", text });
    })
  );

  // Deny changed MCP tools / skills in enforce mode.
  if (ctx.tool?.hook !== undefined) {
    disposables.push(
      await ctx.tool.hook("execute.before", async (event) => {
        if (options.mode !== "enforce") return;
        // Refresh the security-relevant surface before every call. MCP tool
        // descriptors and skill files can change after the first context.
        const enforcementOptions = {
          ...options,
          include: options.include.filter((kind) => kind !== "plugins"),
        };
        enforcement = await inspectRuntime(ctx, enforcementOptions, directory, home);
        if (!enforcement.locked) return;
        const tool = typeof event.tool === "string" ? event.tool : "";
        if (tool === "execute") {
          // Code Mode can reach any MCP tool or skill through property access
          // or aliases, so a string search is not a security boundary. Fail
          // closed for the whole catalog while either asset class drifts.
          if (
            (options.include.includes("mcp") && changedMCPServers(enforcement).size > 0) ||
            (options.include.includes("skills") && changedSkills(enforcement).size > 0)
          ) {
            throw await toolError(
              "MCP tools or skills changed since opencode.lock.json; review and run /integrity lock"
            );
          }
          return;
        }
        if (tool === "skill") {
          const name = toolNameFromInput(event.input);
          if (name !== undefined && changedSkills(enforcement).has(name)) {
            throw await toolError(
              `skill ${name} changed since opencode.lock.json; review and run /integrity lock`
            );
          }
          return;
        }
        const changedServers = changedMCPServers(enforcement);
        const server = serverForTool(tool, Object.keys(enforcement.assets.mcp));
        if (server !== undefined && changedServers.has(server)) {
          throw await toolError(
            `MCP server ${server} changed since opencode.lock.json; review and run /integrity lock`
          );
        }
        const changedTool = enforcement.drift.find(
          (entry) => entry.asset === "mcp-tool" && entry.id === tool
        );
        if (changedTool !== undefined) {
          throw await toolError(
            `${tool} changed since opencode.lock.json; review and run /integrity lock`
          );
        }
      })
    );
  }

  if (ctx.command?.transform !== undefined) {
    disposables.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: INTEGRITY_COMMAND.name,
          description: INTEGRITY_COMMAND.description,
          execute: async (commandInput: Json) => {
            const sessionID =
              typeof commandInput.sessionID === "string" ? commandInput.sessionID : "";
            if (sessionID.length === 0) return;
            const prompt = object(commandInput.prompt);
            const text =
              typeof prompt.text === "string"
                ? prompt.text
                : typeof commandInput.text === "string"
                  ? commandInput.text
                  : "";
            const action = text.trim().split(/\s+/)[0] ?? "audit";
            try {
              if (action === "lock") {
                if (sessionID.length > 0 && ctx.permission?.assert !== undefined) {
                  await ctx.permission.assert({
                    sessionID,
                    action: "integrity_lock",
                    resources: [options.lockfile],
                    save: [],
                    metadata: { source: "opencode-integrity" },
                  });
                }
                const result = await lockRuntime(ctx, options, directory, home);
                cached = undefined;
                enforcement = undefined;
                await ctx.session.synthetic({
                  sessionID,
                  text: `opencode-integrity: locked ${result.path} (${Object.keys(result.lockfile.assets.plugins).length} plugins, ${Object.keys(result.lockfile.assets.mcp).length} MCP servers, ${Object.keys(result.lockfile.assets.skills).length} skills).`,
                });
                return;
              }
              const result = await refresh();
              await ctx.session.synthetic({
                sessionID,
                text: `opencode-integrity ${VERSION} (${action}):\n${describeAudit(result, true)}`,
              });
            } catch (error) {
              await ctx.session.synthetic({
                sessionID,
                text: `opencode-integrity: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          },
        });
      })
    );
  }

  if (ctx.tool?.transform !== undefined) {
    disposables.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: STATUS_TOOL_NAME,
          description: STATUS_TOOL_DESCRIPTION,
          input: STATUS_TOOL_INPUT,
          execute: async (toolInput: unknown) => ({
            content: (await statusTool(refresh, toolInput)).content,
          }),
        });
        if (canForceAsk)
          editor.add({
            name: LOCK_TOOL_NAME,
            description: LOCK_TOOL_DESCRIPTION,
            input: LOCK_TOOL_INPUT,
            execute: async (_toolInput: unknown, context: Json) => {
              const sessionID =
                typeof context.sessionID === "string" ? context.sessionID : undefined;
              if (sessionID === undefined || ctx.permission?.assert === undefined) {
                throw await toolError("integrity_lock requires an interactive session approval");
              }
              await ctx.permission.assert({
                sessionID,
                action: "integrity_lock",
                resources: [options.lockfile],
                save: [],
                metadata: { source: "opencode-integrity" },
              });
              const result = await lockRuntime(ctx, options, directory, home);
              cached = undefined;
              enforcement = undefined;
              return {
                content: `locked ${result.path} (${Object.keys(result.lockfile.assets.plugins).length} plugins, ${Object.keys(result.lockfile.assets.mcp).length} MCP servers, ${Object.keys(result.lockfile.assets.skills).length} skills).`,
              };
            },
          });
      })
    );
  }

  debug("ready", directory, options.mode);
  console.error(`[opencode-integrity] ready (mode=${options.mode}, lock=${options.lockfile})`);

  return async () => {
    for (const disposable of disposables.reverse()) {
      try {
        await disposable.dispose();
      } catch {
        // Unload must not throw.
      }
    }
  };
}
