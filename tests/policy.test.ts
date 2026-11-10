import { describe, expect, test } from "bun:test";
import { localPluginTarget } from "../src/config.ts";
import { generatePolicy, pluginPolicyResource, SELF_PLUGIN } from "../src/policy.ts";
import type { Assets } from "../src/types.ts";

const assets: Assets = {
  plugins: {
    local: { source: "./plugins/demo" },
    scoped: { source: "@scope/pkg@1.2.3" },
    plain: { source: "plain@2.0.0" },
  },
  mcp: { demo: { transport: "local", configHash: "x" } },
  skills: { demo: { path: "demo", contentHash: "x", bytes: 1 } },
};

describe("pluginPolicyResource", () => {
  test("keeps local paths and strips package versions", () => {
    expect(pluginPolicyResource("./plugins/demo")).toBe("./plugins/demo");
    expect(pluginPolicyResource("/opt/plugins/demo")).toBe("/opt/plugins/demo");
    expect(pluginPolicyResource("@scope/pkg")).toBe("@scope/pkg");
    expect(pluginPolicyResource("@scope/pkg@1.2.3")).toBe("@scope/pkg");
    expect(pluginPolicyResource("plain")).toBe("plain");
    expect(pluginPolicyResource("plain@2.0.0")).toBe("plain");
  });
});

describe("generatePolicy", () => {
  test("emits only allow statements by default", () => {
    const { policies } = generatePolicy(assets);
    expect(policies.some((entry) => entry.effect === "deny")).toBe(false);
    expect(policies).toContainEqual({ action: "mcp.use", resource: "demo", effect: "allow" });
    expect(policies).toContainEqual({ action: "skill.use", resource: "demo", effect: "allow" });
    expect(policies).toContainEqual({
      action: "plugin.use",
      resource: "@scope/pkg",
      effect: "allow",
    });
    expect(policies).toContainEqual({ action: "plugin.use", resource: "plain", effect: "allow" });
  });

  test("deny-unlisted puts a deny before the matching allows", () => {
    const { policies } = generatePolicy(assets, { denyUnlisted: true });
    for (const action of ["mcp.use", "skill.use", "plugin.use"] as const) {
      const actionPolicies = policies.filter((entry) => entry.action === action);
      expect(actionPolicies[0]).toEqual({ action, resource: "*", effect: "deny" });
      expect(actionPolicies.slice(1).every((entry) => entry.effect === "allow")).toBe(true);
    }
  });

  test("always allows itself when plugin denies are enabled", () => {
    const { policies } = generatePolicy(assets, { denyUnlisted: true });
    expect(policies).toContainEqual({
      action: "plugin.use",
      resource: SELF_PLUGIN,
      effect: "allow",
    });
    expect(
      policies.filter((entry) => entry.action === "plugin.use" && entry.resource === SELF_PLUGIN)
    ).toHaveLength(1);
  });

  test("does not treat ~/ as a local path", () => {
    expect(localPluginTarget({ target: "~/plugin" }, "/project")).toBeUndefined();
    const tilde = generatePolicy(
      {
        plugins: { tilde: { source: "~/plugin" } },
        mcp: {},
        skills: {},
      },
      { denyUnlisted: true, include: ["plugins"] }
    );
    expect(tilde.policies).toContainEqual({
      action: "plugin.use",
      resource: "~/plugin",
      effect: "allow",
    });
    expect(tilde.policies.some((entry) => entry.resource.startsWith("/home/"))).toBe(false);
  });

  test("emits every resolved local target", () => {
    const { policies } = generatePolicy(assets, {
      denyUnlisted: true,
      include: ["plugins"],
      resolvePlugin: (source) =>
        source === "./plugins/demo" ? ["/tmp/link/demo", "/tmp/real/demo"] : source,
    });
    expect(policies).toContainEqual({
      action: "plugin.use",
      resource: "/tmp/link/demo",
      effect: "allow",
    });
    expect(policies).toContainEqual({
      action: "plugin.use",
      resource: "/tmp/real/demo",
      effect: "allow",
    });
  });

  test("uses the resolved local plugin target", () => {
    const { policies } = generatePolicy(assets, {
      denyUnlisted: true,
      resolvePlugin: (source) =>
        source === "./plugins/demo" ? "/tmp/project/plugins/demo" : source,
    });
    expect(policies).toContainEqual({
      action: "plugin.use",
      resource: "/tmp/project/plugins/demo",
      effect: "allow",
    });
    expect(policies).not.toContainEqual({
      action: "plugin.use",
      resource: "./plugins/demo",
      effect: "allow",
    });
  });

  test("honours include for both denies and allows", () => {
    const { policies } = generatePolicy(assets, { denyUnlisted: true, include: ["mcp"] });
    expect(policies.every((entry) => entry.action === "mcp.use")).toBe(true);
    expect(policies[0]?.effect).toBe("deny");
  });
});
