/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { IncomingHttpHeaders } from "node:http";
import type { OpenAIChatRequest, OpenAIContentBlock } from "../types/openai.js";
import { formatToolsForPrompt } from "./tool-call-parser.js";
import { shouldEnforceOrchestratorStrict } from "../config/orchestrator.js";
import { sessionManager } from "../session/manager.js";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
  /** True when strict OpenClaw-orchestrator mode is active for this request */
  orchestratorStrict?: boolean;
}

export interface OpenaiToCliOptions {
  /** Request headers — used for `X-Session-Id` / `X-Claude-Session-Id` */
  headers?: IncomingHttpHeaders;
}

const CLI_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function looksLikeCliSessionUuid(s: string): boolean {
  return CLI_SESSION_UUID_RE.test(s);
}

function pickMetadataSessionId(
  request: OpenAIChatRequest
): string | undefined {
  const m = request.metadata;
  if (!m || typeof m !== "object") return undefined;
  for (const k of [
    "conversation_id",
    "session_id",
    "thread_id",
    "claude_session_id",
  ]) {
    const v = m[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Resolve a stable conversation key from the request (body + headers).
 * Does not map to Claude CLI session UUID — use {@link resolveCliSessionId} for that.
 */
export function resolveSessionId(
  request: OpenAIChatRequest,
  headers?: IncomingHttpHeaders
): string | undefined {
  const fromMeta = pickMetadataSessionId(request);
  if (fromMeta) return fromMeta;

  const fromBody =
    request.session_id?.trim() ||
    request.claude_session_id?.trim() ||
    request.conversation_id?.trim() ||
    request.thread_id?.trim() ||
    request.user?.trim();
  if (fromBody) return fromBody;

  const raw =
    headers?.["x-session-id"] ?? headers?.["x-claude-session-id"];
  if (typeof raw === "string") return raw.trim() || undefined;
  if (Array.isArray(raw) && raw[0]) return raw[0].trim() || undefined;
  return undefined;
}

/**
 * Session id passed to Claude CLI (`--session-id`). UUIDs from the CLI are used
 * as-is; any other stable key is mapped through {@link sessionManager} so
 * multi-turn works when the client sends a conversation id but not a CLI uuid.
 */
export function resolveCliSessionId(
  request: OpenAIChatRequest,
  headers?: IncomingHttpHeaders
): string | undefined {
  const key = resolveSessionId(request, headers);
  if (!key) return undefined;
  if (looksLikeCliSessionUuid(key)) return key;
  return sessionManager.getOrCreate(key, extractModel(request.model));
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names (provider prefixes like `claude-code-cli/` and `claude-max/`
  // are stripped by extractModel before consulting this map)
  "claude-opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-haiku-4": "haiku",
  "claude-haiku-4-5": "haiku",
  // Bare aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
  "opus-max": "opus",
  "sonnet-max": "sonnet",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping provider prefix
  const stripped = model.replace(/^(?:claude-code-cli|claude-max)\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Default to opus (Claude Max subscription)
  return "opus";
}

/**
 * Extract text from a content field that may be a string or array of content blocks.
 * OpenAI API allows content as either:
 *   - A plain string: "Hello"
 *   - An array of content blocks: [{"type": "text", "text": "Hello"}]
 */
function extractText(content: string | OpenAIContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" || block.type === "input_text")
      .map((block) => block.text)
      .join("\n");
  }
  return String(content || "");
}

/**
 * Strip OpenClaw-specific tooling sections from system prompts.
 * These reference tools (exec, process, web_search, etc.) that don't exist
 * in the Claude Code CLI environment, causing the model to get confused.
 * We remove: ## Tooling, ## Tool Call Style, ## OpenClaw CLI Quick Reference,
 * ## OpenClaw Self-Update
 */
function stripOpenClawTooling(text: string): string {
  const sectionsToStrip = [
    "## Tooling",
    "## Tool Call Style",
    "## OpenClaw CLI Quick Reference",
    "## OpenClaw Self-Update",
  ];
  let result = text;
  for (const section of sectionsToStrip) {
    // Match from section header to the next ## header (or end of string)
    const pattern = new RegExp(
      section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "\\n[\\s\\S]*?(?=\\n## |$)",
      "g"
    );
    result = result.replace(pattern, "");
  }
  // Clean up excessive blank lines left behind
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(
  messages: OpenAIChatRequest["messages"],
  options?: { stripOpenClawSections?: boolean }
): string {
  const stripOpenClawSections = options?.stripOpenClawSections !== false;

  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system": {
        // System messages become context instructions
        // In default mode, strip OpenClaw tooling sections that conflict with
        // Claude Code. In orchestrator strict mode, preserve them for OpenClaw.
        const systemBody = stripOpenClawSections
          ? stripOpenClawTooling(text)
          : text;
        parts.push(`<system>\n${systemBody}\n</system>\n`);
        break;
      }

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant":
        // Previous assistant responses for context
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;

      case "tool":
        // Tool result messages from OpenClaw — include tool_call_id for context
        parts.push(
          `<tool_result tool_call_id="${msg.tool_call_id || "unknown"}">\n${text}\n</tool_result>\n`
        );
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(
  request: OpenAIChatRequest,
  options?: OpenaiToCliOptions
): CliInput {
  const orchestratorStrict = shouldEnforceOrchestratorStrict(request);
  let prompt = messagesToPrompt(request.messages, {
    stripOpenClawSections: !orchestratorStrict,
  });

  // Inject external tool definitions into the prompt if tools are provided
  if (request.tools && request.tools.length > 0) {
    const toolsPrompt = formatToolsForPrompt(request.tools, orchestratorStrict);
    if (toolsPrompt) {
      prompt = `<system>\n${toolsPrompt}\n</system>\n\n${prompt}`;
    }
  }

  return {
    prompt,
    model: extractModel(request.model),
    sessionId: resolveCliSessionId(request, options?.headers),
    orchestratorStrict,
  };
}
