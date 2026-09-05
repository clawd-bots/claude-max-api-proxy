/**
 * Environment variable resolution with legacy-name fallback.
 *
 * This project's flags were originally prefixed `CLAW_PROXY_` after OpenClaw,
 * the agent framework that first consumed the proxy. OpenClaw has been retired
 * and replaced by Hermes, so the prefix is now `CLAUDE_MAX_PROXY_` — named for
 * this project rather than for whichever caller happens to be in front of it.
 *
 * The legacy names still resolve so existing units, scripts, and shells keep
 * working; each one warns once on first use so the stragglers surface instead of
 * silently falling back to defaults.
 */

const warned = new Set<string>();

/**
 * Read an env var by its current name, falling back to a legacy name.
 * Returns undefined when neither is set.
 */
export function readEnv(name: string, legacyName: string): string | undefined {
  const current = process.env[name];
  if (current !== undefined && current !== "") return current;

  const legacy = process.env[legacyName];
  if (legacy !== undefined && legacy !== "") {
    if (!warned.has(legacyName)) {
      warned.add(legacyName);
      console.error(
        `[proxy] ${legacyName} is deprecated (OpenClaw-era name); use ${name} instead.`
      );
    }
    return legacy;
  }
  return undefined;
}

/** True when the resolved value is 1, true, or yes (case-insensitive). */
export function readBooleanEnv(name: string, legacyName: string): boolean {
  const v = readEnv(name, legacyName);
  if (v === undefined) return false;
  return /^(1|true|yes)$/i.test(v.trim());
}
