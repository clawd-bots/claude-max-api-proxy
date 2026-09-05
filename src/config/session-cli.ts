/**
 * Claude CLI session persistence flags.
 *
 * When `CLAUDE_MAX_PROXY_NO_SESSION_PERSISTENCE` is set, always pass
 * `--no-session-persistence` (stateless, no disk).
 * Otherwise, omit `--no-session-persistence` when `--session-id` is set so the
 * CLI can resume the same session across requests (requires stable `user` on
 * the OpenAI request body).
 */

import { readBooleanEnv } from "./env.js";

export function shouldForceNoSessionPersistence(): boolean {
  return readBooleanEnv(
    "CLAUDE_MAX_PROXY_NO_SESSION_PERSISTENCE",
    "CLAW_PROXY_NO_SESSION_PERSISTENCE"
  );
}
