import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function tempDir(prefix = "oi-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

export async function project(): Promise<{ directory: string; home: string }> {
  const directory = await tempDir("oi-project-");
  const home = join(directory, "home");
  return { directory, home };
}

export async function localPlugin(directory: string, name = "demo-plugin"): Promise<string> {
  const root = join(directory, "plugins", name);
  await writeJson(join(root, "package.json"), {
    name,
    version: "1.2.3",
    type: "module",
    exports: "./index.ts",
  });
  await writeText(join(root, "index.ts"), "export default { id: 'demo' };\n");
  return root;
}
