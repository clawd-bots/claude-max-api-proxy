/**
 * Optional chat request logging for debugging (no secrets beyond prompt content).
 */

import type { OpenAIChatRequest } from "../types/openai.js";
import type { CliInput } from "../adapter/openai-to-cli.js";
import { readBooleanEnv } from "./env.js";

export function shouldLogChatRequests(): boolean {
  return readBooleanEnv(
    "CLAUDE_MAX_PROXY_LOG_REQUESTS",
    "CLAW_PROXY_LOG_REQUESTS"
  )
}

const PREVIEW_CHARS = 2000

export function logChatRequestDebug(
  requestId: string,
  body: OpenAIChatRequest,
  cliInput: CliInput
): void {
  if (!shouldLogChatRequests()) return
  const truncated =
    cliInput.prompt.length > PREVIEW_CHARS
      ? `${cliInput.prompt.slice(0, PREVIEW_CHARS)}…`
      : cliInput.prompt
  console.error(
    `[proxy] request=${requestId} model=${body.model} messages=${body.messages.length} ` +
      `promptLen=${cliInput.prompt.length} sessionId=${cliInput.sessionId ?? "(none)"} ` +
      `orchestratorStrict=${Boolean(cliInput.orchestratorStrict)}`
  )
  console.error(`[proxy] prompt preview (up to ${PREVIEW_CHARS} chars):\n${truncated}`)
}
