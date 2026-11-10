import { describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  detectCapabilities,
  detectSuspicious,
  hashDirectory,
  parseJsonc,
  stableStringify,
} from "../src/util.ts";
import { tempDir, writeText } from "./helpers.ts";

describe("stableStringify", () => {
  test("sorts keys at every depth", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}'
    );
  });

  test("drops undefined values", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("parseJsonc", () => {
  test("strips comments and trailing commas", () => {
    expect(
      parseJsonc(`{
        // comment
        "a": 1, /* block */
        "b": [1, 2,],
      }`)
    ).toEqual({ a: 1, b: [1, 2] });
  });

  test("does not touch commas inside strings", () => {
    expect(parseJsonc('{"a":"x,}","b":"// not a comment"}')).toEqual({
      a: "x,}",
      b: "// not a comment",
    });
  });

  test("invalid JSON throws", () => {
    expect(() => parseJsonc("{")).toThrow();
  });
});

describe("hashDirectory", () => {
  test("hashes directory symlink contents", async () => {
    const directory = await tempDir("oi-symlink-");
    await writeText(join(directory, "lib", "file.js"), "clean");
    await symlink(join(directory, "lib"), join(directory, "linked"));
    const first = await hashDirectory(directory);
    await writeText(join(directory, "lib", "file.js"), "malicious");
    const second = await hashDirectory(directory);
    expect(second.hash).not.toBe(first.hash);
  });

  test("counts symlink target bytes against the cap", async () => {
    const root = await tempDir("oi-cap-");
    const targets = await tempDir("oi-target-");
    for (let index = 0; index < 3; index += 1) {
      await writeText(join(targets, `file-${index}.js`), "x".repeat(16));
      await symlink(join(targets, `file-${index}.js`), join(root, `link-${index}.js`));
    }
    const result = await hashDirectory(root, 10, 20);
    expect(result.truncated).toBe(true);
  });

  test("is stable and changes with content", async () => {
    const directory = await tempDir("oi-hash-");
    await writeText(join(directory, "a.txt"), "one");
    const first = await hashDirectory(directory);
    const second = await hashDirectory(directory);
    expect(first.hash).toBe(second.hash);
    await writeText(join(directory, "a.txt"), "two");
    expect((await hashDirectory(directory)).hash).not.toBe(first.hash);
  });
});

describe("detectCapabilities", () => {
  test("finds network, fs, process and env", () => {
    expect(
      detectCapabilities(
        "import { readFile } from 'node:fs'; fetch('https://x'); child_process.spawn(); process.env.TOKEN"
      )
    ).toEqual(["network", "filesystem", "process", "environment"]);
  });
});

describe("detectSuspicious", () => {
  test("finds hidden instructions and zero-width text", () => {
    expect(detectSuspicious("ignore previous instructions\u200b")).toEqual([
      "zero-width-characters",
      "ignore-instructions",
    ]);
  });
});
