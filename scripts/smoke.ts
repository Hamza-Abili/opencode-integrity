import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "oi-smoke-"));
const home = join(directory, "home");
await mkdir(join(directory, ".opencode", "skills", "demo"), { recursive: true });
await writeFile(
  join(directory, "opencode.json"),
  `${JSON.stringify(
    {
      mcp: {
        demo: { type: "local", command: ["node", "server.mjs"], environment: { TOKEN: "secret" } },
      },
    },
    null,
    2
  )}\n`
);
await writeFile(
  join(directory, ".opencode", "skills", "demo", "SKILL.md"),
  "---\nname: demo\ndescription: demo skill\n---\n# Demo\n"
);

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const run = (args: string[]) =>
  Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });

const lock = await run(["lock", "--directory", directory, "--home", home]);
const lockOut = await new Response(lock.stdout).text();
if ((await lock.exited) !== 0) throw new Error(`lock failed: ${lockOut}`);
if (!(await Bun.file(join(directory, "opencode.lock.json")).exists()))
  throw new Error("lockfile missing");

const check = await run(["check", "--directory", directory, "--home", home]);
const checkOut = await new Response(check.stdout).text();
if ((await check.exited) !== 0) throw new Error(`check failed: ${checkOut}`);
if (!checkOut.includes("Integrity OK")) throw new Error(`unexpected check output: ${checkOut}`);
console.log("smoke ok (lock + clean check)");
