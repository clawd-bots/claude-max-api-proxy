/**
 * Claude CLI session persistence flags.
 *
 * When `CLAW_PROXY_NO_SESSION_PERSISTENCE` is set, always pass
 * `--no-session-persistence` (stateless, no disk).
 * Otherwise, omit `--no-session-persistence` when `--session-id` is set so the
 * CLI can resume the same session across requests (requires stable `user` on
 * the OpenAI request body).
 */

export function shouldForceNoSessionPersistence(): boolean {
  const v = process.env.CLAW_PROXY_NO_SESSION_PERSISTENCE;
  if (v === undefined || v === "") return false;
  return /^(1|true|yes)$/i.test(v.trim());
}
