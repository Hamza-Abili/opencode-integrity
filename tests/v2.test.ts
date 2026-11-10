import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseOptions } from "../src/options.ts";
import { lockRuntime } from "../src/runtime.ts";
import { setup } from "../src/v2.ts";
import { localPlugin, project, writeJson, writeText } from "./helpers.ts";

type Callback = (event: Record<string, unknown>) => Promise<void> | void;

async function fixture(
  description = "search docs",
  skillContent = "---\nname: demo\n---\n# Demo\n"
) {
  const { directory, home } = await project();
  const plugin = await localPlugin(directory);
  await writeJson(join(directory, "opencode.json"), {
    plugins: [plugin],
    mcp: { demo: { type: "local", command: ["node", "server.mjs"] } },
  });
  await writeText(join(directory, ".opencode", "skills", "demo", "SKILL.md"), skillContent);

  const state = { description, skillContent };
  const hooks = new Map<string, Callback>();
  const commands: Array<Record<string, unknown>> = [];
  const tools: Array<Record<string, unknown>> = [];
  const synthetic: Array<Record<string, unknown>> = [];
  const permissions: Array<Record<string, unknown>> = [];
  const mcpTransforms: Array<(editor: Record<string, unknown>) => void> = [];
  const skillTransforms: Array<(editor: Record<string, unknown>) => void> = [];
  const skillRemoved: string[] = [];
  const permissionHooks = new Map<string, Callback>();

  const ctx: Record<string, unknown> = {
    app: { version: "2.2.6" },
    location: { directory },
    options: { mode: "enforce", lockfile: join(directory, "opencode.lock.json") },
    plugin: { list: async () => ({ data: [{ source: { type: "local", path: plugin } }] }) },
    mcp: {
      list: async () => ({ data: [{ name: "demo" }] }),
      transform: async (callback: (editor: Record<string, unknown>) => void) => {
        mcpTransforms.push(callback);
        return { dispose: () => undefined };
      },
    },
    skill: {
      list: async () => ({
        data: [
          {
            id: "demo",
            name: "Demo",
            path: join(directory, ".opencode", "skills", "demo", "SKILL.md"),
            content: state.skillContent,
          },
        ],
      }),
      transform: async (callback: (editor: Record<string, unknown>) => void) => {
        skillTransforms.push(callback);
        return { dispose: () => undefined };
      },
    },
    tool: {
      list: async () => [
        {
          id: "demo_search",
          name: "search",
          description: state.description,
          input: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      hook: async (name: string, callback: Callback) => {
        hooks.set(name, callback);
        return { dispose: () => undefined };
      },
      transform: async (
        callback: (editor: { add: (tool: Record<string, unknown>) => void }) => void
      ) => {
        callback({
          add: (tool) => {
            tools.push(tool);
          },
        });
        return { dispose: () => undefined };
      },
    },
    session: {
      hook: async (name: string, callback: Callback) => {
        hooks.set(`session:${name}`, callback);
        return { dispose: () => undefined };
      },
      synthetic: async (value: Record<string, unknown>) => {
        synthetic.push(value);
        return {};
      },
      interrupt: async () => ({}),
    },
    command: {
      transform: async (
        callback: (editor: { add: (command: Record<string, unknown>) => void }) => void
      ) => {
        callback({
          add: (command) => {
            commands.push(command);
          },
        });
        return { dispose: () => undefined };
      },
    },
    permission: {
      hook: async (name: string, callback: Callback) => {
        permissionHooks.set(name, callback);
        return { dispose: () => undefined };
      },
      assert: async (value: Record<string, unknown>) => {
        permissions.push(value);
      },
    },
  };
  return {
    directory,
    home,
    plugin,
    ctx,
    hooks,
    commands,
    tools,
    synthetic,
    permissions,
    mcpTransforms,
    skillTransforms,
    skillRemoved,
    permissionHooks,
    state,
  };
}

describe("V2 adapter", () => {
  test("blocks a changed MCP tool in enforce mode", async () => {
    const first = await fixture();
    const opts = parseOptions(
      { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") },
      first.directory,
      first.home
    );
    await lockRuntime(first.ctx, opts, first.directory, first.home);

    const second = await fixture("changed description");
    (second.ctx.location as Record<string, unknown>).directory = first.directory;
    second.ctx.options = { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") };
    const dispose = await setup(second.ctx, { home: first.home });
    await expect(
      second.hooks.get("execute.before")?.({
        sessionID: "s",
        tool: "demo_search",
        input: {},
      })
    ).rejects.toThrow("changed since opencode.lock.json");
    await dispose();
  });

  test("denies all Code Mode execution while MCP drift exists", async () => {
    const first = await fixture();
    const opts = parseOptions(
      { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") },
      first.directory,
      first.home
    );
    await lockRuntime(first.ctx, opts, first.directory, first.home);
    const second = await fixture("changed description");
    (second.ctx.location as Record<string, unknown>).directory = first.directory;
    second.ctx.options = { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") };
    await setup(second.ctx, { home: first.home });
    await expect(
      second.hooks.get("execute.before")?.({
        sessionID: "s",
        tool: "execute",
        input: { code: "return await tools['demo']['echo']({ text: 'x' })" },
      })
    ).rejects.toThrow("MCP tools or skills changed");
  });

  test("denies Code Mode execution when a skill changed", async () => {
    const first = await fixture();
    const opts = parseOptions(
      { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") },
      first.directory,
      first.home
    );
    await lockRuntime(first.ctx, opts, first.directory, first.home);
    const second = await fixture("search docs", "---\nname: demo\n---\n# Changed\n");
    (second.ctx.location as Record<string, unknown>).directory = first.directory;
    second.ctx.options = { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") };
    await setup(second.ctx, { home: first.home });
    await expect(
      second.hooks.get("execute.before")?.({
        sessionID: "s",
        tool: "execute",
        input: { code: "return await tools.skill({ name: 'demo' })" },
      })
    ).rejects.toThrow("MCP tools or skills changed");
  });

  test("include:plugins skips MCP and skill enforcement", async () => {
    const { ctx, mcpTransforms, skillTransforms } = await fixture();
    (ctx.options as Record<string, unknown>).include = ["plugins"];
    await setup(ctx, { home: (ctx.location as Record<string, unknown>).directory as string });
    expect(mcpTransforms).toHaveLength(0);
    expect(skillTransforms).toHaveLength(0);
  });

  test("integrity_lock refuses without a session", async () => {
    const { ctx, tools } = await fixture();
    await setup(ctx, { home: (ctx.location as Record<string, unknown>).directory as string });
    const tool = tools.find((entry) => entry.name === "integrity_lock");
    const execute = tool?.execute as (input: unknown, context: unknown) => Promise<unknown>;
    await expect(execute({}, {})).rejects.toThrow("interactive session approval");
  });

  test("refreshes the audit after the first context", async () => {
    const first = await fixture();
    const opts = parseOptions(
      { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") },
      first.directory,
      first.home
    );
    await lockRuntime(first.ctx, opts, first.directory, first.home);
    const second = await fixture();
    (second.ctx.location as Record<string, unknown>).directory = first.directory;
    second.ctx.options = { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") };
    await setup(second.ctx, { home: first.home });
    await second.hooks.get("session:context")?.({ sessionID: "s", system: [] });
    second.state.description = "changed after context";
    await expect(
      second.hooks.get("execute.before")?.({
        sessionID: "s",
        tool: "demo_search",
        input: {},
      })
    ).rejects.toThrow("changed since opencode.lock.json");
  });

  test("removes a new skill in enforce mode", async () => {
    const first = await fixture();
    const opts = parseOptions(
      { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") },
      first.directory,
      first.home
    );
    await lockRuntime(first.ctx, opts, first.directory, first.home);
    const second = await fixture();
    (second.ctx.location as Record<string, unknown>).directory = first.directory;
    second.ctx.options = { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") };
    await setup(second.ctx, { home: first.home });
    const removed: string[] = [];
    second.skillTransforms[0]?.({
      list: () => [
        {
          id: "new-skill",
          path: join(first.directory, ".opencode", "skills", "new", "SKILL.md"),
          content: "x",
        },
      ],
      remove: (id: string) => removed.push(id),
    });
    expect(removed).toContain("new-skill");
  });

  test("removes the whole changed skill in enforce mode", async () => {
    const first = await fixture();
    const opts = parseOptions(
      { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") },
      first.directory,
      first.home
    );
    await lockRuntime(first.ctx, opts, first.directory, first.home);

    const second = await fixture("search docs", "---\nname: demo\n---\n# Changed\n");
    (second.ctx.location as Record<string, unknown>).directory = first.directory;
    second.ctx.options = { mode: "enforce", lockfile: join(first.directory, "opencode.lock.json") };
    await setup(second.ctx, { home: first.home });
    const transform = second.skillTransforms[0];
    expect(transform).toBeDefined();
    const removed: string[] = [];
    transform?.({
      list: () => [{ id: "demo", content: "---\nname: demo\n---\n# Changed\n" }],
      remove: (id: string) => removed.push(id),
    });
    expect(removed).toEqual(["demo"]);
  });

  test("forces integrity_lock permission checks to ask", async () => {
    const { ctx, permissionHooks } = await fixture();
    await setup(ctx, { home: (ctx.location as Record<string, unknown>).directory as string });
    const evaluate = permissionHooks.get("evaluate");
    expect(evaluate).toBeDefined();
    const event: Record<string, unknown> = { action: "integrity_lock", effect: "allow" };
    await evaluate?.(event);
    expect(event.effect).toBe("ask");
  });

  test("registers status and lock tools plus the command", async () => {
    const { ctx, tools, commands } = await fixture();
    await setup(ctx, { home: (ctx.location as Record<string, unknown>).directory as string });
    expect(tools.map((tool) => tool.name)).toContain("integrity_status");
    expect(tools.map((tool) => tool.name)).toContain("integrity_lock");
    expect(commands.map((command) => command.name)).toContain("integrity");
  });

  test("/integrity lock writes the lockfile and reports", async () => {
    const { ctx, commands, synthetic, directory, permissions } = await fixture();
    (ctx.options as Record<string, unknown>).mode = "warn";
    await setup(ctx, { home: directory });
    const command = commands.find((entry) => entry.name === "integrity");
    const execute = command?.execute as (input: Record<string, unknown>) => Promise<void>;
    await execute({ sessionID: "s", prompt: { text: "lock" }, delivery: "queue" });
    expect(await Bun.file(join(directory, "opencode.lock.json")).exists()).toBe(true);
    expect(synthetic.some((entry) => String(entry.text).includes("locked"))).toBe(true);
    expect(permissions[0]?.action).toBe("integrity_lock");
  });
});
