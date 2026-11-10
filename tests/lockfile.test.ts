import { describe, expect, test } from "bun:test";
import { audit, createLockfile, diffAssets, formatDrift } from "../src/lockfile.ts";
import type { Assets } from "../src/types.ts";

function assets(overrides: Partial<Assets> = {}): Assets {
  return {
    plugins: {},
    mcp: {},
    skills: {},
    ...overrides,
  };
}

describe("createLockfile", () => {
  test("sorts asset keys for a deterministic file", () => {
    const lockfile = createLockfile({
      plugins: { b: { source: "b" }, a: { source: "a" } },
      mcp: {
        z: { transport: "local", configHash: "x" },
        a: { transport: "local", configHash: "x" },
      },
      skills: {
        z: { path: "z", contentHash: "x", bytes: 1 },
        a: { path: "a", contentHash: "x", bytes: 1 },
      },
    });
    expect(Object.keys(lockfile.assets.plugins)).toEqual(["a", "b"]);
    expect(Object.keys(lockfile.assets.mcp)).toEqual(["a", "z"]);
    expect(Object.keys(lockfile.assets.skills)).toEqual(["a", "z"]);
  });
});

describe("diffAssets", () => {
  test("detects plugin additions, changes and removals", () => {
    const base = assets({
      plugins: {
        demo: {
          source: "demo",
          version: "1.0.0",
          contentHash: "sha256:a",
          capabilities: ["filesystem"],
        },
      },
    });
    const current = assets({
      plugins: {
        demo: {
          source: "demo",
          version: "1.1.0",
          contentHash: "sha256:b",
          capabilities: ["filesystem", "network"],
        },
        new: { source: "new", contentHash: "sha256:c" },
      },
    });
    const drift = diffAssets(base, current);
    expect(
      drift.some(
        (entry) => entry.asset === "plugin" && entry.id === "demo" && entry.change === "changed"
      )
    ).toBe(true);
    expect(drift.some((entry) => entry.id === "new" && entry.change === "added")).toBe(true);
    expect(drift.some((entry) => entry.field?.includes("network"))).toBe(true);

    const removed = diffAssets(current, assets());
    expect(removed.filter((entry) => entry.change === "removed")).toHaveLength(2);
  });

  test("detects MCP config and tool descriptor changes", () => {
    const base = assets({
      mcp: {
        demo: {
          transport: "local",
          configHash: "sha256:config",
          tools: {
            search: {
              descriptorHash: "sha256:d",
              descriptionHash: "sha256:desc",
              inputHash: "sha256:in",
            },
          },
        },
      },
    });
    const current = assets({
      mcp: {
        demo: {
          transport: "local",
          configHash: "sha256:config2",
          tools: {
            search: {
              descriptorHash: "sha256:d2",
              descriptionHash: "sha256:desc2",
              inputHash: "sha256:in",
            },
            write: {
              descriptorHash: "sha256:w",
              descriptionHash: "sha256:wd",
              inputHash: "sha256:wi",
            },
          },
        },
      },
    });
    const drift = diffAssets(base, current);
    expect(drift.some((entry) => entry.asset === "mcp" && entry.field === "config")).toBe(true);
    expect(
      drift.some(
        (entry) =>
          entry.asset === "mcp-tool" &&
          entry.id === "search" &&
          entry.field?.includes("description")
      )
    ).toBe(true);
    expect(
      drift.some(
        (entry) => entry.asset === "mcp-tool" && entry.id === "write" && entry.change === "added"
      )
    ).toBe(true);
  });

  test("surfaces suspicious content on a changed tool", () => {
    const base = assets({
      mcp: {
        demo: {
          transport: "local",
          configHash: "sha256:c",
          tools: {
            search: {
              descriptorHash: "sha256:d",
              descriptionHash: "sha256:a",
              inputHash: "sha256:i",
            },
          },
        },
      },
    });
    const current = assets({
      mcp: {
        demo: {
          transport: "local",
          configHash: "sha256:c",
          tools: {
            search: {
              descriptorHash: "sha256:d2",
              descriptionHash: "sha256:b",
              inputHash: "sha256:i",
              suspicious: ["ignore-instructions"],
            },
          },
        },
      },
    });
    expect(diffAssets(base, current)[0]?.message).toContain("suspicious");
  });

  test("detects skill content changes", () => {
    const base = assets({ skills: { demo: { path: "a", contentHash: "sha256:a", bytes: 1 } } });
    const current = assets({ skills: { demo: { path: "a", contentHash: "sha256:b", bytes: 2 } } });
    expect(diffAssets(base, current)[0]?.asset).toBe("skill");
  });
});

describe("audit", () => {
  test("unlocked is not an error", () => {
    const result = audit(undefined, assets(), []);
    expect(result.locked).toBe(false);
    expect(result.ok).toBe(true);
  });

  test("locked and clean is ok", () => {
    const value = assets();
    expect(audit(value, value, []).ok).toBe(true);
  });

  test("formats drift", () => {
    const drift = diffAssets(assets(), assets({ plugins: { x: { source: "x" } } }));
    expect(formatDrift(drift)).toContain("new plugin x");
  });
});
