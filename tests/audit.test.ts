import { describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { collectStaticAssets, filterIgnored, mergeRuntimeTools } from "../src/audit.ts";
import { pluginAssetKey } from "../src/config.ts";
import { createLockfile, readLockfile } from "../src/lockfile.ts";
import { generatePolicy } from "../src/policy.ts";
import type { Assets } from "../src/types.ts";
import { localPlugin, project, tempDir, writeJson, writeText } from "./helpers.ts";

async function fixture() {
  const { directory, home } = await project();
  const plugin = await localPlugin(directory);
  await writeJson(join(directory, "opencode.json"), {
    plugins: [plugin],
    mcp: {
      demo: { type: "local", command: ["node", "server.mjs"], environment: { TOKEN: "secret" } },
    },
  });
  await writeText(
    join(directory, ".opencode", "skills", "demo", "SKILL.md"),
    "---\nname: demo\n---\n# Demo\n"
  );
  return { directory, home, plugin };
}

describe("collectStaticAssets", () => {
  test("collects local plugins, MCP config and skills", async () => {
    const { directory, home } = await fixture();
    const result = await collectStaticAssets(directory, home);
    expect(Object.keys(result.assets.plugins)).toHaveLength(1);
    expect(result.assets.mcp.demo?.transport).toBe("local");
    expect(result.assets.skills.demo).toBeDefined();
  });

  test("honours include and includeGlobal", async () => {
    const { directory, home } = await fixture();
    const onlyPlugins = await collectStaticAssets(directory, home, {
      include: ["plugins"],
      includeGlobal: false,
    });
    expect(Object.keys(onlyPlugins.assets.plugins)).toHaveLength(1);
    expect(onlyPlugins.assets.mcp).toEqual({});
    expect(onlyPlugins.assets.skills).toEqual({});

    await writeJson(join(home, ".config", "opencode", "opencode.json"), {
      mcp: { servers: { global: { type: "local", command: ["node", "global.mjs"] } } },
    });
    const withGlobal = await collectStaticAssets(directory, home, {
      include: ["mcp"],
      includeGlobal: true,
    });
    expect(withGlobal.assets.mcp.global).toBeDefined();
  });

  test("resolves relative plugin targets for policy", async () => {
    const { directory, home } = await project();
    await localPlugin(directory);
    await writeJson(join(directory, "opencode.json"), { plugins: ["./plugins/demo-plugin"] });
    const result = await collectStaticAssets(directory, home);
    expect(result.policyTargets.get("./plugins/demo-plugin")).toContain(
      join(directory, "plugins", "demo-plugin")
    );

    const dotConfig = await project();
    await localPlugin(join(dotConfig.directory, ".opencode"));
    await writeJson(join(dotConfig.directory, ".opencode", "opencode.json"), {
      plugins: ["./plugins/demo-plugin"],
    });
    const dotResult = await collectStaticAssets(dotConfig.directory, dotConfig.home);
    expect(Object.keys(dotResult.assets.plugins)).toEqual(["./.opencode/plugins/demo-plugin"]);
    expect(dotResult.policyTargets.get("./.opencode/plugins/demo-plugin")).toContain(
      join(dotConfig.directory, ".opencode", "plugins", "demo-plugin")
    );
  });

  test("keeps distinct relative plugins declared by both config files", async () => {
    const { directory, home } = await project();
    await writeJson(join(directory, "plugins", "demo-plugin", "package.json"), {
      name: "root-plugin",
      version: "1.0.0",
    });
    await writeText(join(directory, "plugins", "demo-plugin", "index.ts"), "export default {};\n");
    await writeJson(join(directory, ".opencode", "plugins", "demo-plugin", "package.json"), {
      name: "dot-plugin",
      version: "1.0.0",
    });
    await writeText(
      join(directory, ".opencode", "plugins", "demo-plugin", "index.ts"),
      "export default {};\n"
    );
    await writeJson(join(directory, "opencode.json"), {
      plugins: ["./plugins/demo-plugin"],
    });
    await writeJson(join(directory, ".opencode", "opencode.json"), {
      plugins: ["./plugins/demo-plugin"],
    });
    const result = await collectStaticAssets(directory, home);
    expect(Object.keys(result.assets.plugins).sort()).toEqual([
      "./.opencode/plugins/demo-plugin",
      "./plugins/demo-plugin",
    ]);
    expect(result.policyTargets.size).toBe(2);
  });

  test("uses real paths for project-relative keys", async () => {
    const { directory } = await project();
    const plugin = await localPlugin(directory);
    const parent = await tempDir("oi-link-");
    const linked = join(parent, "project");
    await symlink(directory, linked);
    expect(pluginAssetKey({ target: plugin }, linked)).toBe("./plugins/demo-plugin");
    expect(pluginAssetKey({ target: "./plugins/demo-plugin", configDir: linked }, linked)).toBe(
      "./plugins/demo-plugin"
    );
  });

  test("policy allows both lexical and real local targets", async () => {
    const { directory, home } = await project();
    await localPlugin(directory);
    await writeJson(join(directory, "opencode.json"), {
      plugins: ["./plugins/demo-plugin"],
    });
    const parent = await tempDir("oi-link-");
    const linked = join(parent, "project");
    await symlink(directory, linked);
    const result = await collectStaticAssets(linked, home);
    const { policies } = generatePolicy(result.assets, {
      denyUnlisted: true,
      include: ["plugins"],
      resolvePlugin: (source) => result.policyTargets.get(source) ?? source,
    });
    for (const target of [linked, directory]) {
      expect(policies).toContainEqual({
        action: "plugin.use",
        resource: join(target, "plugins", "demo-plugin"),
        effect: "allow",
      });
    }
  });

  test("does not crash on a malformed file URL", async () => {
    const { directory, home } = await project();
    await writeJson(join(directory, "opencode.json"), {
      plugins: ["file://bad host/x"],
    });
    const result = await collectStaticAssets(directory, home);
    expect(result.assets.plugins).toEqual({});
    expect(result.warnings.some((warning) => warning.includes("not installed"))).toBe(true);
  });

  test("rejects a local plugin outside the project", async () => {
    const { directory, home } = await project();
    const outside = await localPlugin(await project().then((value) => value.directory), "outside");
    await writeJson(join(directory, "opencode.json"), { plugins: [outside] });
    const result = await collectStaticAssets(directory, home);
    expect(Object.keys(result.assets.plugins)).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.includes("outside the project"))).toBe(true);
  });
});

describe("mergeRuntimeTools", () => {
  test("keeps runtime tools when config is unchanged and drops them when it changes", () => {
    const current: Assets = {
      plugins: {},
      skills: {},
      mcp: { demo: { transport: "local", configHash: "sha256:a", toolsSource: "none" } },
    };
    const previous = createLockfile({
      plugins: {},
      skills: {},
      mcp: {
        demo: {
          transport: "local",
          configHash: "sha256:a",
          tools: {
            search: {
              descriptorHash: "sha256:d",
              descriptionHash: "sha256:x",
              inputHash: "sha256:i",
            },
          },
        },
      },
    });
    expect(Object.keys(mergeRuntimeTools(current, previous).mcp.demo?.tools ?? {})).toHaveLength(1);
    const demo = current.mcp.demo;
    if (demo === undefined) throw new Error("demo asset missing");
    const changed = { ...current, mcp: { demo: { ...demo, configHash: "sha256:b" } } };
    expect(mergeRuntimeTools(changed, previous).mcp.demo?.tools).toBeUndefined();
  });
});

describe("filterIgnored", () => {
  test("matches asset and prefixed ids", () => {
    const drift = [
      {
        asset: "plugin" as const,
        id: "demo",
        change: "added" as const,
        severity: "high" as const,
        message: "x",
      },
      {
        asset: "mcp-tool" as const,
        id: "search",
        parent: "mcp",
        change: "changed" as const,
        severity: "high" as const,
        message: "y",
      },
    ];
    expect(filterIgnored(drift, ["demo"])).toHaveLength(1);
    expect(filterIgnored(drift, ["mcp:search"])).toHaveLength(1);
  });
});

describe("cli", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  async function run(args: string[]) {
    const child = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, stdout, stderr };
  }

  test("lock, check, tamper, check fails, sarif and policy", async () => {
    const { directory, home } = await fixture();
    const base = ["--directory", directory, "--home", home];

    const lock = await run(["lock", ...base]);
    expect(lock.code).toBe(0);
    expect(lock.stdout).toContain("locked");
    const lockfile = await readLockfile(join(directory, "opencode.lock.json"));
    expect(lockfile?.assets.skills.demo).toBeDefined();

    const clean = await run(["check", ...base]);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain("Integrity OK");

    await writeText(
      join(directory, ".opencode", "skills", "demo", "SKILL.md"),
      "---\nname: demo\n---\n# Changed\n"
    );
    const dirty = await run(["check", ...base]);
    expect(dirty.code).toBe(1);
    expect(dirty.stdout).toContain("skill demo");

    const sarif = await run(["check", ...base, "--format", "sarif"]);
    expect(JSON.parse(sarif.stdout).version).toBe("2.1.0");

    const policy = await run(["policy", ...base, "--deny-unlisted"]);
    const parsed = JSON.parse(policy.stdout) as {
      policies: Array<{ action: string; effect: string }>;
    };
    expect(parsed.policies.some((entry) => entry.action === "skill.use")).toBe(true);
    expect(parsed.policies.some((entry) => entry.effect === "deny")).toBe(true);

    const onlyMcp = await run(["policy", ...base, "--deny-unlisted", "--include", "mcp"]);
    const mcpPolicies = JSON.parse(onlyMcp.stdout) as {
      policies: Array<{ action: string; effect: string }>;
    };
    expect(mcpPolicies.policies.every((entry) => entry.action === "mcp.use")).toBe(true);
  });

  test("policy resolves relative plugin targets and allows itself", async () => {
    const { directory, home } = await project();
    await localPlugin(directory);
    await writeJson(join(directory, "opencode.json"), {
      plugins: ["./plugins/demo-plugin"],
    });
    const result = await run([
      "policy",
      "--directory",
      directory,
      "--home",
      home,
      "--deny-unlisted",
      "--include",
      "plugins",
    ]);
    const parsed = JSON.parse(result.stdout) as {
      policies: Array<{ action: string; resource: string; effect: string }>;
    };
    expect(parsed.policies).toContainEqual({
      action: "plugin.use",
      resource: join(directory, "plugins", "demo-plugin"),
      effect: "allow",
    });
    expect(parsed.policies).toContainEqual({
      action: "plugin.use",
      resource: "@hamzaabili/opencode-integrity",
      effect: "allow",
    });
  });

  test("policy resolves lock-only local plugins against the project", async () => {
    const { directory, home } = await project();
    await localPlugin(directory);
    await writeJson(join(directory, "opencode.json"), {
      plugins: ["./plugins/demo-plugin"],
    });
    const base = ["--directory", directory, "--home", home];
    expect((await run(["lock", ...base])).code).toBe(0);
    await writeJson(join(directory, "opencode.json"), {});
    const result = await run(["policy", ...base, "--deny-unlisted", "--include", "plugins"]);
    const parsed = JSON.parse(result.stdout) as {
      policies: Array<{ action: string; resource: string; effect: string }>;
    };
    expect(parsed.policies).toContainEqual({
      action: "plugin.use",
      resource: join(directory, "plugins", "demo-plugin"),
      effect: "allow",
    });
  });

  test("check fails when the lockfile is missing", async () => {
    const { directory, home } = await fixture();
    const result = await run(["check", "--directory", directory, "--home", home]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("No lockfile");
  });

  test("SARIF reports a missing lockfile", async () => {
    const { directory, home } = await fixture();
    const result = await run([
      "check",
      "--directory",
      directory,
      "--home",
      home,
      "--format",
      "sarif",
    ]);
    const sarif = JSON.parse(result.stdout) as {
      runs: Array<{ results: Array<{ ruleId: string }> }>;
    };
    expect(
      sarif.runs[0]?.results.some((entry) => entry.ruleId === "integrity/lockfile-missing")
    ).toBe(true);
  });

  test("audit --json is machine readable", async () => {
    const { directory, home } = await fixture();
    const result = await run(["audit", "--directory", directory, "--home", home, "--json"]);
    const parsed = JSON.parse(result.stdout) as {
      locked: boolean;
      assets: { skills: Record<string, unknown> };
    };
    expect(parsed.locked).toBe(false);
    expect(parsed.assets.skills.demo).toBeDefined();
  });
});
