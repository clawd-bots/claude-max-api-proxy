/**
 * OpenClaw-first orchestrator strict mode (env CLAW_PROXY_ORCHESTRATOR_STRICT).
 * When enabled together with a non-empty `tools` array on the request, the proxy
 * uses OpenClaw-first prompts and blocks most Claude Code native tool_use
 * (Read/Glob/Grep remain allowed for local read-only inspection).
 */

import type { OpenAIChatRequest } from "../types/openai.js";

/**
 * True when CLAW_PROXY_ORCHESTRATOR_STRICT is set to a truthy value (1, true, yes).
 */
export function isOrchestratorStrict(): boolean {
  const v = process.env.CLAW_PROXY_ORCHESTRATOR_STRICT;
  if (v === undefined || v === "") return false;
  return /^(1|true|yes)$/i.test(v.trim());
}

/**
 * Strict prompts + native-tool enforcement apply only when the env flag is on
 * and the client sent tool definitions (OpenClaw use case).
 */
export function shouldEnforceOrchestratorStrict(
  request: OpenAIChatRequest
): boolean {
  return (
    isOrchestratorStrict() &&
    Array.isArray(request.tools) &&
    request.tools.length > 0
  );
}
