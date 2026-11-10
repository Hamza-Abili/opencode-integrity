import { createHash, randomUUID } from "node:crypto";
import { type Dirent, realpathSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export async function readTextFileCapped(
  path: string,
  maxBytes = 2 * 1024 * 1024
): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (info.size > maxBytes) return undefined;
  } catch {
    return undefined;
  }
  return await readTextFile(path);
}

export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readJsonFileCapped<T>(
  path: string,
  maxBytes = 2 * 1024 * 1024
): Promise<T | undefined> {
  const text = await readTextFileCapped(path, maxBytes);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  const text = await readTextFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function writeFileAtomic(path: string, content: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode });
  await rename(temporary, path);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashText(value: string): string {
  return `sha256:${sha256(value)}`;
}

export function shortHash(value: string): string {
  return value.replace(/^sha256:/, "").slice(0, 12);
}

/** Deterministic JSON: object keys are sorted at every depth. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function hashObject(value: unknown): string {
  return hashText(stableStringify(value));
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve symlinks when possible; fall back to the lexical path. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isInsideReal(parent: string, child: string): boolean {
  return isInside(realPath(parent), realPath(child));
}

export interface DirectoryHash {
  readonly hash: string;
  readonly files: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

const IGNORED_DIRS = new Set([".git"]);

/**
 * Hash a package/plugin directory. Build output (`dist`) and hidden files are
 * included because they can be executed; symlinks are recorded by target.
 */
export async function hashDirectory(
  root: string,
  maxFiles = 5000,
  maxBytes = 50 * 1024 * 1024
): Promise<DirectoryHash> {
  const files: Array<{ path: string; content: Buffer }> = [];
  const visited = new Set<string>();
  let bytes = 0;
  let truncated = false;

  async function walk(directory: string, depth: number): Promise<void> {
    if (truncated) return;
    if (depth > 32) {
      truncated = true;
      return;
    }
    let real: string;
    try {
      real = await realpath(directory);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles || bytes >= maxBytes) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(join(directory, entry.name), depth + 1);
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target = "";
        try {
          target = await readlink(path);
        } catch {
          continue;
        }
        let content = Buffer.from(`link:${target}`);
        try {
          const targetPath = resolve(dirname(path), target);
          const info = await stat(targetPath);
          if (info.isDirectory()) {
            await walk(targetPath, depth + 1);
          } else if (info.isFile()) {
            if (info.size > maxBytes - bytes) {
              truncated = true;
              return;
            }
            const targetContent = await readFile(targetPath);
            bytes += targetContent.byteLength;
            content = Buffer.from(`link:${target}\0${sha256(targetContent.toString("base64"))}`);
          }
        } catch {
          // Broken link: the target string is still hashed.
        }
        files.push({ path: relative(root, path), content });
        bytes += content.byteLength;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(path);
        if (info.size > maxBytes - bytes) {
          truncated = true;
          return;
        }
        const content = await readFile(path);
        files.push({ path: relative(root, path), content });
        bytes += content.byteLength;
      } catch {
        // Unreadable files are skipped, not fatal.
      }
    }
  }

  await walk(root, 0);
  const lines = files
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}\0${sha256(file.content.toString("base64"))}`);
  return {
    hash: hashText(lines.join("\n")),
    files: files.length,
    bytes,
    truncated,
  };
}

/** Strip comments and trailing commas from JSONC, preserving string contents. */
export function parseJsonc(text: string): unknown {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      output += " ";
      continue;
    }
    output += character;
  }
  let cleaned = "";
  let string = false;
  let escapedInString = false;
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index] ?? "";
    if (string) {
      cleaned += character;
      if (escapedInString) escapedInString = false;
      else if (character === "\\") escapedInString = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') {
      string = true;
      cleaned += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < output.length && /\s/.test(output[next] ?? "")) next += 1;
      const following = output[next] ?? "";
      if (following === "}" || following === "]") continue;
    }
    cleaned += character;
  }
  return JSON.parse(cleaned);
}

export async function readJsoncFile(path: string): Promise<unknown> {
  const text = await readTextFile(path);
  if (text === undefined) return undefined;
  try {
    return parseJsonc(text);
  } catch {
    return undefined;
  }
}

export function globMatch(pattern: string, value: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, "s").test(value);
  } catch {
    return false;
  }
}

export function ignored(id: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globMatch(pattern, id));
}

const CAPABILITY_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["network", /\b(fetch\(|node:https?|from ["']https?["']|undici|WebSocket|axios)/],
  ["filesystem", /\b(node:fs|from ["']fs["']|readFile|writeFile|readdir|mkdir)/],
  ["process", /\b(child_process|spawn\(|execFile\(|exec\()/],
  ["environment", /process\.env/],
  ["dynamic-code", /\b(eval\(|new Function\()/],
];

export function detectCapabilities(text: string): string[] {
  return CAPABILITY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

const SUSPICIOUS_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["zero-width-characters", /[\u200B-\u200D\uFEFF]/],
  ["bidi-controls", /[\u202A-\u202E\u2066-\u2069]/],
  ["html-comment", /<!--/],
  [
    "ignore-instructions",
    /\b(ignore|disregard)\s+(all\s+)?(previous|prior|above)\s+instructions?\b/i,
  ],
  ["do-not-tell", /\bdo\s+not\s+(tell|inform|mention)\b/i],
  ["exfiltration-language", /\b(exfiltrate|send\s+.*\b(token|secret|credential|env)\b)/i],
];

export function detectSuspicious(text: string): string[] {
  return SUSPICIOUS_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function truncate(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
