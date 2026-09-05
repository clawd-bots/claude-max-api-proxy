/**
 * Caller-first orchestrator strict mode (env CLAUDE_MAX_PROXY_ORCHESTRATOR_STRICT).
 * When enabled together with a non-empty `tools` array on the request, the proxy
 * uses caller-first prompts and blocks most Claude Code native tool_use
 * (Read/Glob/Grep remain allowed for local read-only inspection).
 */

import type { OpenAIChatRequest } from "../types/openai.js";
import { readBooleanEnv } from "./env.js";

/**
 * True when CLAUDE_MAX_PROXY_ORCHESTRATOR_STRICT is set to a truthy value (1, true, yes).
 */
export function isOrchestratorStrict(): boolean {
  return readBooleanEnv(
    "CLAUDE_MAX_PROXY_ORCHESTRATOR_STRICT",
    "CLAW_PROXY_ORCHESTRATOR_STRICT"
  );
}

/**
 * Strict prompts + native-tool enforcement apply only when the env flag is on
 * and the client sent tool definitions (agent-framework use case).
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
