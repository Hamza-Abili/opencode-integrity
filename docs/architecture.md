# Architecture

## Pipeline

```text
project config ──▶ static assets ──┐
                                   ├─▶ diff ──▶ audit / check / SARIF
opencode.lock.json ────────────────┘
        ▲
        │  /integrity lock (V2)
        │
live OpenCode ──▶ plugins + MCP configs + MCP tool descriptors + skills
```

The CLI can only see project files and installed package content. MCP tool
descriptions and schemas exist only after a server connection, so they are
captured by the V2 adapter and written by `/integrity lock` or the
`integrity_lock` tool.

## Static assets

- **Plugins**: every `plugins`/`plugin` entry in `opencode.json(c)` and
  `.opencode/opencode.json(c)`, plus direct files/directories under
  `.opencode/plugins/`. A package is resolved from `node_modules` or the
  nearest `package.json` above its entry; its package.json and files are
  hashed.
- **MCP**: V2 `mcp.servers` and legacy direct `mcp.<name>` entries. Secret
  values are replaced before hashing; key names are kept.
- **Skills**: `.opencode/skills/**/SKILL.md` under the project.

## Runtime assets

- `ctx.plugin.list()` → package/local sources; project-scoped by default.
- `ctx.mcp.list()` → connected server names.
- `ctx.tool.list()` → live MCP tools as `<server>_<tool>`, including Code Mode.
- `ctx.skill.list()` → content and path; embedded `skill://` entries are
  excluded.

## Lockfile

`opencode.lock.json` is versioned JSON. It stores hashes, paths, versions,
capability labels and suspicious labels. It never stores tool descriptions,
skill bodies or environment values. Runtime tool hashes are preserved by a CLI
`lock` only when the MCP configuration hash is unchanged.

## Enforcement

`warn` injects a report. `enforce`:

1. Disables MCP servers whose configuration is new or changed (before use).
2. Removes changed known skills from the advertised set.
3. Denies changed MCP tools and skills in `execute.before`.

A plugin is code already running when its hook is registered; a hook cannot
unload it. Plugin changes are reported and require a restart after review.

## Non-goals

- Not a malware scanner or signature verifier.
- Not a sandbox (use `opencode-sandbox` for command isolation).
- Not a network/egress monitor.
- Not a proof that a clean descriptor is safe.
