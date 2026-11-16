/**
 * Live compatibility check against a real OpenCode installation.
 *
 * Starts an ephemeral `opencode serve` with this plugin configured in an
 * isolated HOME/XDG and a temporary project. Asserts:
 *   1. the plugin is active in `/api/plugin`;
 *   2. setup registered the `/integrity` command;
 *   3. `/integrity audit` reads the live runtime and returns a synthetic audit.
 *
 * This is intentionally model-free: it exercises plugin load, command
 * registration and runtime collection without an API key. The host-local
 * `harness/run.ts` still covers MCP tool capture and enforcement.
 *
 * Usage: bun run compat   (or OPENCODE_BIN=/path bun run compat)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_ROOT = process.env.PLUGIN_SPEC ?? path.resolve(import.meta.dir, "..");
const OPENCODE = process.env.OPENCODE_BIN ?? "opencode";
const PLUGIN_ID = "opencode-integrity";
const password = crypto.randomUUID();
const port = 50900 + (process.pid % 200);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oi-compat-"));
const project = path.join(root, "project");
const home = path.join(root, "home");
const config = path.join(root, "config");
const data = path.join(root, "data");
const cache = path.join(root, "cache");
const runtime = path.join(root, "runtime");
const lockfile = path.join(project, "opencode.lock.json");

// Minimal allowlist: never inherit unrelated credentials from the caller.
const env: NodeJS.ProcessEnv = {};
for (const key of [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "SHELL",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
env.HOME = home;
env.XDG_CONFIG_HOME = config;
env.XDG_DATA_HOME = data;
env.XDG_CACHE_HOME = cache;
env.XDG_RUNTIME_DIR = runtime;
env.OPENCODE_SERVER_PASSWORD = password;

for (const dir of [home, config, data, cache, project]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.mkdirSync(path.join(config, "opencode"), { recursive: true });
fs.writeFileSync(
  path.join(config, "opencode", "opencode.json"),
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugins: [
      {
        package: PLUGIN_ROOT,
        options: { mode: "warn" },
      },
    ],
  })
);

fs.mkdirSync(path.join(project, ".opencode", "skills", "demo"), { recursive: true });
fs.writeFileSync(
  path.join(project, ".opencode", "skills", "demo", "SKILL.md"),
  "---\nname: demo\ndescription: demo skill\n---\n# Demo\n"
);

let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
try {
  child = Bun.spawn({
    cmd: [OPENCODE, "serve", "--port", String(port)],
    cwd: project,
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
} catch (error) {
  fs.rmSync(root, { recursive: true, force: true });
  throw error;
}

let stderrTail = "";
async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        stderrTail = (stderrTail + decoder.decode()).slice(-8000);
        return;
      }
      stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-8000);
    }
  } catch {
    // server closed
  }
}
const drainDone = drain(child.stderr as ReadableStream<Uint8Array>);

function tail(text: string): string {
  return text.trim().split("\n").slice(-15).join("\n");
}

function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1***:***@");
}

function fail(message: string): never {
  console.error(`FAIL: ${redact(message)}`);
  if (stderrTail.trim()) console.error(`opencode stderr (tail):\n${redact(tail(stderrTail))}`);
  process.exit(1);
}

let stopped = false;
function stop(): void {
  if (stopped) return;
  stopped = true;
  try {
    child.kill();
  } catch {
    // already exited
  }
}

process.on("exit", () => {
  stop();
  if (process.env.INTEGRITY_KEEP_COMPAT === "1") {
    console.error(`compat root kept at ${root}`);
    return;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

async function request(
  pathname: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: {
      authorization: auth,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function api(pathname: string): Promise<{ status: number; body: unknown }> {
  return await request(pathname);
}

async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 45_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await drainDone;
      fail(
        `OpenCode server exited before ${label}: ${stderrTail.trim() || `exit ${child.exitCode ?? child.signalCode}`}`
      );
    }
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await Bun.sleep(500);
  }
  fail(`timed out waiting for ${label}`);
}

type PluginInfo = { id: string; state?: { status?: string; message?: string } };
const plugins = await waitFor("the plugin", async () => {
  const response = await api("/api/plugin");
  if (response.status !== 200) return undefined;
  const data = (response.body as { data?: PluginInfo[] }).data ?? [];
  return data.some((plugin) => plugin.id === PLUGIN_ID && plugin.state?.status === "active")
    ? data
    : undefined;
});
const plugin = plugins.find((candidate) => candidate.id === PLUGIN_ID);
console.log(`PASS plugin: ${plugin?.id} state=${plugin?.state?.status}`);

type CommandInfo = { name: string };
const commands = await waitFor("the integrity command", async () => {
  const response = await api("/api/command");
  if (response.status !== 200) return undefined;
  const data = (response.body as { data?: CommandInfo[] }).data ?? [];
  return data.some((command) => command.name === "integrity") ? data : undefined;
});
console.log(`PASS command: ${commands.find((command) => command.name === "integrity")?.name}`);

const ready = await waitFor("the plugin ready log", async () => {
  const match = stderrTail.match(/\[opencode-integrity\] ready \(mode=warn, lock=([^)]+)\)/);
  return match === null ? undefined : match;
});
console.log(`PASS setup: mode=warn lock=${path.basename(ready[1])}`);

const created = await request("/api/session", { method: "POST", body: "{}" });
if (created.status !== 200) fail(`session creation failed: ${created.status}`);
const sessionID = (created.body as { data?: { id?: string } }).data?.id;
if (sessionID === undefined) {
  fail(`session creation returned no id: ${JSON.stringify(created.body)}`);
}

const audit = await request(`/api/session/${sessionID}/command`, {
  method: "POST",
  body: JSON.stringify({ name: "integrity", text: "audit" }),
});
if (audit.status !== 204) {
  fail(`integrity audit command failed: ${audit.status} ${JSON.stringify(audit.body)}`);
}

type SessionMessage = { type?: string; text?: string };
const message = await waitFor("the integrity audit result", async () => {
  const response = await api(`/api/session/${sessionID}/message`);
  if (response.status !== 200) return undefined;
  const data = (response.body as { data?: SessionMessage[] }).data ?? [];
  return data.find(
    (entry) => entry.type === "synthetic" && entry.text?.includes("opencode-integrity")
  );
});
if (!message.text?.includes("(audit):")) {
  fail(`unexpected audit result: ${JSON.stringify(message.text)}`);
}
if (!message.text.includes("No lockfile found")) {
  fail(`audit did not report the expected unlocked state: ${JSON.stringify(message.text)}`);
}
if (!/\b1 skill\(s\)/.test(message.text)) {
  fail(`audit did not discover the demo skill: ${JSON.stringify(message.text)}`);
}
if (!message.text.includes("skill demo")) {
  fail(`audit output is missing the demo skill: ${JSON.stringify(message.text)}`);
}
if (fs.existsSync(lockfile)) fail("audit unexpectedly wrote a lockfile");
console.log("PASS audit: live runtime inspected, demo skill discovered, no lockfile written");

console.log(`PASS live compatibility against ${OPENCODE}`);

// The server keeps the event loop alive; exit explicitly for a clean CI job.
stop();
process.exit(0);
