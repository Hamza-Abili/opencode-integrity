import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseOptions } from "../src/options.ts";
import {
  changedMCPServers,
  changedSkills,
  collectRuntime,
  inspectRuntime,
  lockRuntime,
} from "../src/runtime.ts";
import { localPlugin, project, writeJson, writeText } from "./helpers.ts";

async function fixture(description = "search docs") {
  const { directory, home } = await project();
  const plugin = await localPlugin(directory);
  await writeJson(join(directory, "opencode.json"), {
    plugins: [plugin],
    mcp: { demo: { type: "local", command: ["node", "server.mjs"] } },
  });
  await writeText(
    join(directory, ".opencode", "skills", "demo", "SKILL.md"),
    "---\nname: demo\n---\n# Demo\n"
  );
  const ctx = {
    app: { version: "2.2.6" },
    plugin: {
      list: async () => ({
        data: [{ source: { type: "local", path: plugin } }],
      }),
    },
    mcp: { list: async () => ({ data: [{ name: "demo" }] }) },
    skill: {
      list: async () => ({
        data: [
          {
            id: "demo",
            name: "Demo",
            path: join(directory, ".opencode", "skills", "demo", "SKILL.md"),
            content: "---\nname: demo\n---\n# Demo\n",
          },
        ],
      }),
    },
    tool: {
      list: async () => [
        {
          id: "demo_search",
          name: "search",
          description,
          input: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    },
  };
  return { directory, home, plugin, ctx };
}

const options = (directory: string, home: string) =>
  parseOptions(
    { mode: "enforce", lockfile: join(directory, "opencode.lock.json") },
    directory,
    home
  );

describe("collectRuntime", () => {
  test("captures plugin, MCP tools and skills", async () => {
    const { directory, home, ctx } = await fixture();
    const snapshot = await collectRuntime(ctx, directory, home);
    expect(Object.keys(snapshot.assets.plugins)).toHaveLength(1);
    expect(snapshot.assets.mcp.demo?.toolsSource).toBe("runtime");
    expect(snapshot.assets.mcp.demo?.tools?.demo_search).toBeDefined();
    expect(snapshot.assets.skills.demo).toBeDefined();
    expect(snapshot.version).toBe("2.2.6");
  });

  test("does not read excluded asset classes", async () => {
    const { directory, home, ctx } = await fixture();
    let pluginCalls = 0;
    ctx.plugin = {
      list: async () => {
        pluginCalls += 1;
        return { data: [] };
      },
    };
    await collectRuntime(ctx, directory, home, { include: ["mcp"], includeGlobal: false });
    expect(pluginCalls).toBe(0);
  });

  test("detects changes in non-SKILL.md skill files", async () => {
    const { directory, home, ctx } = await fixture();
    const script = join(directory, ".opencode", "skills", "demo", "run.sh");
    await Bun.write(script, "echo clean");
    const opts = options(directory, home);
    await lockRuntime(ctx, opts, directory, home);
    await Bun.write(script, "echo malicious");
    const drift = await inspectRuntime(ctx, opts, directory, home);
    expect(drift.drift.some((entry) => entry.asset === "skill" && entry.field === "files")).toBe(
      true
    );
  });

  test("lock and inspect detect tool descriptor drift", async () => {
    const { directory, home, ctx } = await fixture();
    const opts = options(directory, home);
    await lockRuntime(ctx, opts, directory, home);
    const clean = await inspectRuntime(ctx, opts, directory, home);
    expect(clean.locked).toBe(true);
    expect(clean.ok).toBe(true);

    const changed = await fixture("changed description");
    const drift = await inspectRuntime(changed.ctx, opts, directory, home);
    expect(drift.ok).toBe(false);
    expect(changedMCPServers(drift).has("demo")).toBe(true);
  });
});

describe("changed sets", () => {
  test("separates changed skills and MCP servers", () => {
    const result = {
      locked: true,
      ok: false,
      warnings: [],
      assets: { plugins: {}, mcp: {}, skills: {} },
      drift: [
        {
          asset: "mcp-tool" as const,
          id: "demo_search",
          parent: "demo",
          change: "changed" as const,
          severity: "high" as const,
          message: "x",
        },
        {
          asset: "skill" as const,
          id: "demo",
          change: "changed" as const,
          severity: "high" as const,
          message: "y",
        },
      ],
    };
    expect(changedMCPServers(result).has("demo")).toBe(true);
    expect(changedSkills(result).has("demo")).toBe(true);
  });
});
