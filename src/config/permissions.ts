/**
 * Controls whether the spawned Claude Code CLI runs with
 * `--dangerously-skip-permissions` (env `CLAUDE_MAX_PROXY_SKIP_PERMISSIONS`).
 *
 * The flag disables every confirmation gate in the child process. That is a
 * meaningful blast radius: the child inherits the service user and its working
 * directory, so anything routed through the proxy — including untrusted inbound
 * content the calling agent is relaying — reaches a CLI that can write and
 * execute without prompting.
 *
 * Orchestrator strict mode already blocks mutating native tools at the proxy
 * layer, so the flag is not needed for the primary use case. It defaults to OFF
 * and must be opted into explicitly.
 */
import { readBooleanEnv } from "./env.js";

export function shouldSkipPermissions(): boolean {
  return readBooleanEnv(
    "CLAUDE_MAX_PROXY_SKIP_PERMISSIONS",
    "CLAW_PROXY_SKIP_PERMISSIONS"
  );
}
