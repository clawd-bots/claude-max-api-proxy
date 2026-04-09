/**
 * Tool Call Parser
 *
 * Handles converting OpenAI tool definitions to prompt instructions,
 * and parsing tool call XML blocks from Claude Code CLI text output.
 *
 * Since Claude Code CLI can't accept external tool definitions natively,
 * we inject them into the system prompt and instruct the model to output
 * <tool_call> XML blocks. We then parse these back into OpenAI-format tool_calls.
 */

import type { OpenAIToolDefinition, OpenAIToolCall } from "../types/openai.js";

let callCounter = 0;

/**
 * Generate a unique tool call ID in OpenAI format
 */
export function generateToolCallId(): string {
  callCounter++;
  const ts = Date.now().toString(36);
  const cnt = callCounter.toString(36).padStart(4, "0");
  return `call_${ts}${cnt}`;
}

/**
 * Format OpenAI tool definitions into a system prompt block
 * that instructs the model to output <tool_call> XML when it wants to use them.
 *
 * @param orchestratorStrict — When true (OpenClaw-first strict mode), OpenClaw is
 *   the only execution path; Claude Code native tools must not be used.
 */
export function formatToolsForPrompt(
  tools: OpenAIToolDefinition[],
  orchestratorStrict: boolean = false
): string {
  if (!tools || tools.length === 0) return "";

  const toolDescriptions = tools.map((tool) => {
    const fn = tool.function;
    let desc = `### ${fn.name}`;
    if (fn.description) {
      desc += `\n${fn.description}`;
    }
    if (fn.parameters) {
      desc += `\nParameters: ${JSON.stringify(fn.parameters)}`;
    }
    return desc;
  });

  const rulesOrchestrator = [
    "- The <tool_call> tag MUST be on its own line",
    "- The JSON must be on a single line between the tags",
    "- You may output multiple <tool_call> blocks",
    "- You may output plain text before tool calls to explain your reasoning",
    "- After outputting tool call blocks, do NOT output more text — OpenClaw will execute the tools and continue",
    "- These tools are executed by OpenClaw. You may use Read, Glob, or Grep only for local read-only inspection; do NOT use Write, Edit, Bash, or other native tools for actions OpenClaw tools should perform.",
    "- All actions in the user's environment (desktop, browser, sessions, memory, etc.) MUST go through these tools and <tool_call> blocks only.",
  ];

  const rulesDefault = [
    "- The <tool_call> tag MUST be on its own line",
    "- The JSON must be on a single line between the tags",
    "- You may output multiple <tool_call> blocks",
    "- You may output text before tool calls to explain your reasoning",
    "- After outputting tool call blocks, do NOT output more text — the caller will execute the tools and continue",
    "- Only use these external tools when your built-in tools (Read, Bash, Edit, etc.) cannot accomplish the task",
    "- Prefer these external tools for: web searches, sending messages, memory operations, cron jobs, browser automation, and session management",
  ];

  return [
    "## External Tools (Caller Environment)",
    "",
    "The following tools are available in the calling environment (OpenClaw).",
    "When you need to use one of these tools, output a tool call block in this EXACT format:",
    "",
    "<tool_call>",
    '{"name": "tool_name", "arguments": {"arg1": "value1"}}',
    "</tool_call>",
    "",
    "Rules:",
    ...(orchestratorStrict ? rulesOrchestrator : rulesDefault),
    "",
    "Available tools:",
    "",
    ...toolDescriptions,
  ].join("\n");
}

/**
 * Parse <tool_call> blocks from response text.
 * Returns the cleaned text (with tool_call blocks removed) and extracted tool calls.
 */
export function parseToolCalls(text: string): {
  cleanText: string;
  toolCalls: OpenAIToolCall[];
} {
  const toolCalls: OpenAIToolCall[] = [];

  // Match <tool_call> blocks - allowing whitespace around JSON
  const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let cleanText = text;
  let match: RegExpExecArray | null;

  // Collect all matches first
  const matches: Array<{ full: string; json: string }> = [];
  while ((match = toolCallRegex.exec(text)) !== null) {
    matches.push({ full: match[0], json: match[1].trim() });
  }

  for (const m of matches) {
    try {
      const parsed = JSON.parse(m.json);
      if (parsed.name && typeof parsed.name === "string") {
        toolCalls.push({
          id: generateToolCallId(),
          type: "function",
          function: {
            name: parsed.name,
            arguments:
              typeof parsed.arguments === "string"
                ? parsed.arguments
                : JSON.stringify(parsed.arguments || {}),
          },
        });
      }
    } catch {
      // Malformed JSON — skip this block, leave it in the text
      continue;
    }

    // Remove the matched block from clean text
    cleanText = cleanText.replace(m.full, "");
  }

  // Clean up excessive whitespace left by removals
  cleanText = cleanText.replace(/\n{3,}/g, "\n\n").trim();

  return { cleanText, toolCalls };
}

/**
 * Try to parse a single tool call block content (the text between tags).
 * Returns the parsed tool call or null if malformed.
 *
 * Robust extraction: first tries parsing the full trimmed content as JSON.
 * If that fails, scans for the outermost `{...}` object and tries that.
 * This handles models that include extra whitespace, newlines, or prose
 * around the JSON object inside the <tool_call> block.
 */
function tryParseToolCallBlock(blockContent: string): OpenAIToolCall | null {
  const trimmed = blockContent.trim();
  if (!trimmed) return null;

  // Attempt 1: parse the entire trimmed content
  const result = tryParseAsToolCall(trimmed);
  if (result) return result;

  // Attempt 2: extract the first top-level JSON object from the content
  const braceStart = trimmed.indexOf("{");
  if (braceStart !== -1) {
    // Find the matching closing brace
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = braceStart; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const jsonStr = trimmed.slice(braceStart, i + 1);
          const r = tryParseAsToolCall(jsonStr);
          if (r) return r;
          break;
        }
      }
    }
  }

  return null;
}

/** Helper: parse a JSON string as a tool call if it has the right shape */
function tryParseAsToolCall(json: string): OpenAIToolCall | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed.name && typeof parsed.name === "string") {
      return {
        id: generateToolCallId(),
        type: "function",
        function: {
          name: parsed.name,
          arguments:
            typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments || {}),
        },
      };
    }
  } catch {
    // Malformed JSON
  }
  return null;
}

/**
 * Streaming tool call detector.
 * Maintains state across multiple text chunks to detect <tool_call> blocks.
 *
 * KEY DESIGN: Tool calls are parsed IMMEDIATELY when a complete block is found
 * (returned from processChunk), not deferred to flush(). This allows the caller
 * to kill the subprocess promptly instead of waiting for the CLI to finish
 * potentially long multi-turn tool-use loops.
 */
export class StreamingToolCallDetector {
  private buffer = "";
  private inToolCall = false;
  /** Start index of the current <tool_call> tag in the buffer */
  private toolCallStartTag = "<tool_call>";
  private toolCallEndTag = "</tool_call>";

  /**
   * Process a text chunk. Returns:
   * - emitText: safe text to stream to the client (null = nothing to emit)
   * - toolCalls: any fully parsed tool calls found in this chunk
   */
  processChunk(text: string): {
    emitText: string | null;
    toolCalls: OpenAIToolCall[];
  } {
    this.buffer += text;

    if (this.inToolCall) {
      // We're inside a <tool_call> block, buffer everything
      const endIdx = this.buffer.indexOf(this.toolCallEndTag);
      if (endIdx !== -1) {
        // Found the closing tag — extract and parse the block
        const blockContent = this.buffer.slice(
          this.toolCallStartTag.length,
          endIdx
        );
        const afterEnd = this.buffer.slice(
          endIdx + this.toolCallEndTag.length
        );
        this.buffer = afterEnd;
        this.inToolCall = false;

        const toolCall = tryParseToolCallBlock(blockContent);
        if (toolCall) {
          // Successfully parsed — check for more tool calls in remaining buffer
          const rest = this.processChunk("");
          return {
            emitText: rest.emitText,
            toolCalls: [toolCall, ...rest.toolCalls],
          };
        } else {
          // Malformed JSON — treat the entire block as text
          const blockText = `${this.toolCallStartTag}${blockContent}${this.toolCallEndTag}`;
          const rest = this.processChunk("");
          const combined = blockText + (rest.emitText || "");
          return {
            emitText: combined || null,
            toolCalls: rest.toolCalls,
          };
        }
      }
      // Still waiting for closing tag
      return { emitText: null, toolCalls: [] };
    }

    // Check for start of tool_call tag
    const startIdx = this.buffer.indexOf(this.toolCallStartTag);
    if (startIdx !== -1) {
      // Found a tool_call start — emit text before it, process the rest
      const before = this.buffer.slice(0, startIdx);
      this.buffer = this.buffer.slice(startIdx);
      this.inToolCall = true;
      // Recursively process to check if closing tag is already in buffer
      const rest = this.processChunk("");
      const combined = before + (rest.emitText || "");
      return {
        emitText: combined || null,
        toolCalls: rest.toolCalls,
      };
    }

    // Check for partial tag at end of buffer (e.g., "<tool_" without full tag)
    // We need to hold back text that might be the start of a <tool_call> tag
    for (let i = 1; i < this.toolCallStartTag.length; i++) {
      const suffix = this.buffer.slice(-i);
      if (this.toolCallStartTag.startsWith(suffix)) {
        // Potential partial tag — hold back this suffix
        const safe = this.buffer.slice(0, -i);
        this.buffer = suffix;
        return { emitText: safe || null, toolCalls: [] };
      }
    }

    // No tool call detected — emit everything
    const emit = this.buffer;
    this.buffer = "";
    return { emitText: emit || null, toolCalls: [] };
  }

  /**
   * Flush remaining buffer (call when stream ends).
   * Returns any remaining text and tool calls from partial content.
   *
   * Handles both complete blocks (via parseToolCalls regex) and partial blocks
   * where the opening <tool_call> tag is present but </tool_call> is missing
   * (e.g., subprocess killed mid-block).
   */
  flush(): { remainingText: string; toolCalls: OpenAIToolCall[] } {
    const remaining = this.buffer;
    this.buffer = "";
    const wasInToolCall = this.inToolCall;
    this.inToolCall = false;

    if (!remaining) {
      return { remainingText: "", toolCalls: [] };
    }

    // Parse any complete tool_call blocks in remaining content
    const { cleanText, toolCalls } = parseToolCalls(remaining);

    // If we were mid-block when flushed (no closing tag arrived), try to
    // salvage the partial block. The buffer starts with <tool_call>.
    if (wasInToolCall && toolCalls.length === 0) {
      const tagLen = "<tool_call>".length;
      if (remaining.startsWith("<tool_call>") && remaining.length > tagLen) {
        const blockContent = remaining.slice(tagLen);
        const toolCall = tryParseToolCallBlock(blockContent);
        if (toolCall) {
          // Remove the partial block from emitted text
          return { remainingText: "", toolCalls: [toolCall] };
        }
      }
    }

    return { remainingText: cleanText, toolCalls };
  }
}
