# Changelog

## 0.1.2

- `policy --deny-unlisted` turns the generated statements into a real
  allowlist. Policies default to allow, so the previous output restricted
  nothing on its own.
- Fix plugin policy resources for unscoped versioned packages (`pkg@1.2.3` now
  becomes `pkg`, matching OpenCode's policy target).
- Resolve `./`/`../` local plugin targets against the config file directory, as
  OpenCode does, so their allow statements actually match at runtime.
- Keep `@hamzaabili/opencode-integrity` explicitly allowed when plugin denies
  are enabled, so a globally installed runtime plugin is not disabled by its
  own policy.
- Add `--include` to the CLI.
- Local plugin lock keys are now project-relative and realpath-stable. Re-run
  `lock` after upgrading from 0.1.1 if the project uses local plugins.
- Lockfiles created without an explicit version now use the package version.

## 0.1.1

- First npm-published build. 0.1.0 was superseded before publication because
  npm 9 created an unapprovable staged placeholder during the initial release.
- No functional changes from 0.1.0.

## 0.1.0

First release.

- Audit, lock, check, diff and policy CLI with JSON and SARIF output.
- Lockfile (`opencode.lock.json`) for plugins, MCP configuration, MCP tool
  descriptors and skills.
- Runtime capture of live MCP tool descriptions and input schemas, including
  remote servers and Code Mode.
- Warn/enforce modes: disable changed MCP servers, remove changed skills, deny
  changed MCP tools and skills before execution.
- Plugin content hashing, detected capabilities and version/source pinning.
- Deterministic suspicious-content checks (zero-width, bidi, HTML comments,
  hidden instructions, exfiltration language).
- `integrity_status` and `integrity_lock` tools plus `/integrity` command.
- V1 static audit adapter; V2 full runtime adapter.
- Zero runtime dependencies; local only; no telemetry.
