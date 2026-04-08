/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import {
  parseToolCalls,
  generateToolCallId,
  StreamingToolCallDetector,
} from "../adapter/tool-call-parser.js";
import type { OpenAIChatRequest, OpenAIToolCall } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = new ClaudeSubprocess();

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId, body);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId, body);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  body: OpenAIChatRequest
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    let hasEmittedText = false;
    // Always detect <tool_call> blocks — tools may be defined in the system
    // prompt text even when request.tools is empty (OpenClaw injects them)
    const toolCallDetector = new StreamingToolCallDetector();
    // Accumulate tool calls found mid-stream
    const pendingToolCalls: OpenAIToolCall[] = [];
    // Timer to kill subprocess after tool calls are detected
    let toolCallKillTimer: ReturnType<typeof setTimeout> | null = null;
    // Accumulate all text for debug logging
    let fullText = "";

    // Handle actual client disconnect (response stream closed)
    res.on("close", () => {
      if (toolCallKillTimer) clearTimeout(toolCallKillTimer);
      if (!isComplete) {
        // Client disconnected before response completed - kill subprocess
        subprocess.kill();
      }
      resolve();
    });

    /**
     * Finalize the stream: emit any pending tool calls and close.
     * Called either from the result event (normal) or after tool-call kill (early).
     */
    function finalizeStream(usage?: { input_tokens?: number; output_tokens?: number }) {
      if (res.writableEnded) return;

      // Flush the detector for any remaining content
      const flushed = toolCallDetector.flush();

      // Emit any remaining buffered text
      if (flushed.remainingText) {
        const textChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? ("assistant" as const) : undefined,
              content: flushed.remainingText,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
        isFirst = false;
      }

      // Combine tool calls from mid-stream detection + flush
      const allToolCalls = [...pendingToolCalls, ...flushed.toolCalls];

      // Emit tool call chunks
      for (let i = 0; i < allToolCalls.length; i++) {
        const tc = allToolCalls[i];
        const tcChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? ("assistant" as const) : undefined,
              tool_calls: [{
                index: i,
                id: tc.id,
                type: "function" as const,
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                },
              }],
            },
            finish_reason: null,
          }],
        };
        console.error(`[Streaming] Writing tool_call chunk for: ${tc.function.name}`);
        res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
        isFirst = false;
      }

      const hasToolCalls = allToolCalls.length > 0;
      console.error(`[Streaming] Finalizing: ${allToolCalls.length} tool calls [${allToolCalls.map(tc => tc.function.name).join(", ")}], finish_reason=${hasToolCalls ? "tool_calls" : "stop"}`);

      // Send final done chunk
      const doneChunk = createDoneChunk(requestId, lastModel);
      if (hasToolCalls) {
        doneChunk.choices[0].finish_reason = "tool_calls";
      }
      if (usage) {
        doneChunk.usage = {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        };
      }
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    subprocess.on("text_block_start", () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    });

    // Handle streaming content deltas
    subprocess.on("content_delta", (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (!text || res.writableEnded) return;

      fullText += text;
      const { emitText, toolCalls } = toolCallDetector.processChunk(text);

      // Emit safe text to client
      if (emitText) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? ("assistant" as const) : undefined,
              content: emitText,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }

      // Handle tool calls detected mid-stream
      if (toolCalls.length > 0) {
        pendingToolCalls.push(...toolCalls);
        console.error(`[Streaming] Tool call(s) detected mid-stream: ${toolCalls.map(tc => tc.function.name).join(", ")}`);

        // Reset the kill timer — give 1.5s for more tool calls to arrive,
        // then kill the subprocess and close the stream.
        // This prevents the CLI from entering a multi-turn native tool-use
        // loop that would hang the SSE connection.
        if (toolCallKillTimer) clearTimeout(toolCallKillTimer);
        toolCallKillTimer = setTimeout(() => {
          if (!isComplete && subprocess.isRunning()) {
            console.error(`[Streaming] Killing subprocess — tool calls collected, no need to wait for CLI to finish`);
            isComplete = true;
            subprocess.kill();
            finalizeStream();
          }
        }, 1500);
      }
    });

    // ── Native tool use interception ──
    // When the model uses Claude Code's native tools (Bash, Agent) instead of
    // outputting <tool_call> text blocks, we need to detect and intercept this.
    // This prevents the CLI from entering a multi-turn tool-execution loop that
    // hangs the SSE connection.
    let currentNativeToolName: string | null = null;
    let currentNativeToolInput = "";

    subprocess.on("tool_use_start", (event: ClaudeCliStreamEvent) => {
      const cb = event.event.content_block;
      const toolName = (cb && cb.type === "tool_use" && cb.name) || "unknown";
      currentNativeToolName = toolName;
      currentNativeToolInput = "";
      console.error(`[Streaming] Native tool use detected: ${toolName}`);

      // If we already have pending <tool_call> blocks from text output,
      // the model is confused — kill immediately and emit what we have
      if (pendingToolCalls.length > 0) {
        console.error(`[Streaming] Killing subprocess — native tool started with ${pendingToolCalls.length} pending external tool calls`);
        if (toolCallKillTimer) clearTimeout(toolCallKillTimer);
        if (!isComplete && subprocess.isRunning()) {
          isComplete = true;
          subprocess.kill();
          finalizeStream();
        }
      }
    });

    subprocess.on("input_json_delta", (event: ClaudeCliStreamEvent) => {
      if (currentNativeToolName && event.event.delta?.type === "input_json_delta") {
        currentNativeToolInput += (event.event.delta as { type: "input_json_delta"; partial_json: string }).partial_json;
      }
    });

    subprocess.on("content_block_stop", () => {
      if (!currentNativeToolName || isComplete) {
        currentNativeToolName = null;
        currentNativeToolInput = "";
        return;
      }

      // Intercept Bash commands that try to call openclaw CLI
      if (currentNativeToolName === "Bash" && currentNativeToolInput) {
        try {
          const input = JSON.parse(currentNativeToolInput);
          const cmd = typeof input.command === "string" ? input.command : "";
          if (cmd.match(/\bopenclaw\b/i)) {
            console.error(`[Streaming] Intercepted Bash→openclaw command: ${cmd.slice(0, 150)}`);
            pendingToolCalls.push({
              id: generateToolCallId(),
              type: "function",
              function: {
                name: "exec",
                arguments: JSON.stringify({ command: cmd }),
              },
            });
            if (toolCallKillTimer) clearTimeout(toolCallKillTimer);
            if (!isComplete && subprocess.isRunning()) {
              isComplete = true;
              subprocess.kill();
              finalizeStream();
            }
          }
        } catch {
          // Malformed JSON — ignore
        }
      }

      currentNativeToolName = null;
      currentNativeToolInput = "";
    });

    // Handle final assistant message (for model name)
    subprocess.on("assistant", (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    });

    subprocess.on("result", (result: ClaudeCliResult) => {
      if (toolCallKillTimer) clearTimeout(toolCallKillTimer);
      isComplete = true;
      console.error(`[Streaming] Result received. fullText length=${fullText.length}`);
      finalizeStream(result.usage);
      resolve();
    });

    subprocess.on("error", (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (toolCallKillTimer) clearTimeout(toolCallKillTimer);
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (!isComplete) {
          isComplete = true;
          finalizeStream();
        }
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }
      resolve();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      reject(err);
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  body: OpenAIChatRequest
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        // Always parse tool calls — tools may be defined in system prompt text
        let toolCalls: OpenAIToolCall[] | undefined;
        if (finalResult.result) {
          const parsed = parseToolCalls(finalResult.result);
          if (parsed.toolCalls.length > 0) {
            toolCalls = parsed.toolCalls;
            // Replace result text with cleaned version (tool_call blocks removed)
            finalResult = { ...finalResult, result: parsed.cleanText || "" };
          }
        }
        res.json(cliResultToOpenai(finalResult, requestId, toolCalls));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  const modelIds = [
    "claude-opus-4",
    "claude-opus-4-6",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-haiku-4",
    "claude-haiku-4-5",
  ];
  res.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
