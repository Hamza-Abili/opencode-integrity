/**
 * opencode-integrity — dual OpenCode entry point.
 *
 * V2 calls `setup(ctx)` and inspects the live plugin/MCP/skill/tool surface.
 * V1 calls `server(input, options)` and audits the project-scoped files only.
 */

import { server } from "./v1.ts";
import { setup as setupV2 } from "./v2.ts";

export const plugin = {
  id: "opencode-integrity",
  setup: setupV2,
  server,
};

export default plugin;
export { VERSION } from "./version.ts";
export { server };
