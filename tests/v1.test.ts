import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectStaticAssets, mergeRuntimeTools } from "../src/audit.ts";
import { createLockfile, writeLockfile } from "../src/lockfile.ts";
import { server } from "../src/v1.ts";
import { localPlugin, project, writeJson, writeText } from "./helpers.ts";

async function fixture() {
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
  const assets = await collectStaticAssets(directory, home);
  await writeLockfile(
    join(directory, "opencode.lock.json"),
    createLockfile(mergeRuntimeTools(assets.assets))
  );
  return { directory, home };
}

describe("V1 adapter", () => {
  test("blocks a changed skill in enforce mode", async () => {
    const { directory, home } = await fixture();
    await writeText(
      join(directory, ".opencode", "skills", "demo", "SKILL.md"),
      "---\nname: demo\n---\n# Changed\n"
    );
    const hooks = await server({ directory }, { mode: "enforce" }, { home });
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "skill", sessionID: "s", callID: "c" },
        { args: { name: "demo" } }
      )
    ).rejects.toThrow("changed since opencode.lock.json");
  });

  test("blocks a changed MCP server in enforce mode", async () => {
    const { directory, home } = await fixture();
    await writeJson(join(directory, "opencode.json"), {
      plugins: [],
      mcp: { demo: { type: "local", command: ["node", "other.mjs"] } },
    });
    const hooks = await server({ directory }, { mode: "enforce" }, { home });
    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "demo_search", sessionID: "s", callID: "c" },
        { args: {} }
      )
    ).rejects.toThrow("MCP server demo changed");
  });

  test("include:plugins ignores changed skills", async () => {
    const { directory, home } = await fixture();
    await writeText(
      join(directory, ".opencode", "skills", "demo", "SKILL.md"),
      "---\nname: demo\n---\n# Changed\n"
    );
    const hooks = await server({ directory }, { mode: "enforce", include: ["plugins"] }, { home });
    await hooks["tool.execute.before"]?.(
      { tool: "skill", sessionID: "s", callID: "c" },
      { args: { name: "demo" } }
    );
  });

  test("injects a drift warning into the system prompt", async () => {
    const { directory, home } = await fixture();
    await writeText(
      join(directory, ".opencode", "skills", "demo", "SKILL.md"),
      "---\nname: demo\n---\n# Changed\n"
    );
    const hooks = await server({ directory }, { mode: "warn" }, { home });
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "s" }, output);
    expect(output.system.join("\n")).toContain("drift detected");
  });

  test("does not block when the lockfile is missing", async () => {
    const { directory, home } = await fixture();
    await Bun.write(join(directory, "opencode.lock.json"), "");
    const hooks = await server({ directory }, { mode: "enforce" }, { home });
    await hooks["tool.execute.before"]?.(
      { tool: "skill", sessionID: "s", callID: "c" },
      { args: { name: "demo" } }
    );
  });
});
