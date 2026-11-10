# Security

## What this tool is

`opencode-integrity` records SHA-256 hashes of OpenCode plugin content, MCP
server configuration, MCP tool descriptors and skill files, then compares them
with the running environment. It is a **drift detector**, not a malware
scanner, sandbox, signature verifier or proof of safety.

A lockfile catches the classic rug pull: the plugin/MCP/skill you reviewed is
not the one now loaded. It cannot tell whether the reviewed version was
malicious.

## Trust model

- `opencode.lock.json` is committed and reviewed like code. Anyone who can
  change both the lockfile and the asset can approve the change.
- The model-callable `integrity_lock` tool is exposed only when an evaluate
  hook can force the dedicated `integrity_lock` action to `ask`; the
  user-invoked `/integrity lock` command asks for the same permission.
- `warn` mode never blocks; `enforce` mode blocks **changed** assets only.
- Runtime enforcement covers MCP tools and skills that the plugin can observe.
  A plugin that is already executing cannot be unloaded by a plugin hook.
- V1 enforces static MCP configuration and skill drift, but cannot verify live
  MCP tool descriptors; tool-level enforcement is V2-only.

## Secrets

Config hashes replace values of secret-looking keys (`TOKEN`, `SECRET`,
`PASSWORD`, `API_KEY`, `AUTHORIZATION`, `COOKIE`, `CREDENTIAL`) with
`[redacted]`. The keys still affect the hash; rotating a token does not.

The lockfile contains hashes, paths, versions, capability labels and
suspicious-content labels. It never stores tool descriptions, skill bodies or
environment values.

## Capability and poisoning heuristics

Capability detection and suspicious-instruction labels are deterministic text
heuristics. They produce false positives and false negatives. A clean report is
not a safety guarantee; a suspicious label is a reason to review, not proof of
malice.

## Limitations

- MCP tool descriptors are only visible at runtime. A CLI `check` verifies
  configuration and files, not what a server returns today.
- A server can change behavior without changing names, descriptions or schemas.
- A tool can be malicious while its descriptor is clean.
- `enforce` disables changed MCP servers and skills at load time; a changed
  plugin is reported but cannot be unloaded by a hook.
- The lockfile is not signed. Protect the repository and review lockfile diffs.
- Windows is not tested. Use WSL.

## Reporting

Open a private advisory:
<https://github.com/Hamza-Abili/opencode-integrity/security/advisories/new>

Do not include live tokens, private MCP URLs or full environment dumps. A
minimal reproduction with fake values is enough.
