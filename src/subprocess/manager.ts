/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import {
  isAssistantMessage,
  isResultMessage,
  isContentDelta,
  isTextBlockStart,
  isToolUseBlockStart,
  isInputJsonDelta,
  isContentBlockStop,
} from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { shouldForceNoSessionPersistence } from "../config/session-cli.js";

export interface SubprocessOptions {
  model: ClaudeModel;
  sessionId?: string;
  cwd?: string;
  timeout?: number;
  /** When true, append OPENCLAW_TOOL_MAPPING_PROMPT_STRICT instead of default */
  orchestratorStrict?: boolean;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

const DEFAULT_TIMEOUT = 900000; // 15 minutes

/**
 * System prompt appended to Claude CLI to handle the dual-tool environment.
 *
 * The model runs inside Claude Code CLI (which has native tools: Read, Write, Edit,
 * Bash, Grep, Glob, etc.) but the caller (OpenClaw) also provides external tools
 * (exec, browser, web_search, memory_search, cron, sessions, etc.).
 *
 * External/OpenClaw tools MUST be called via <tool_call> XML blocks in the response
 * text — they are intercepted by the proxy and forwarded to OpenClaw for execution.
 * The model must NEVER attempt to run OpenClaw tools via Bash or any native tool.
 */
const OPENCLAW_TOOL_MAPPING_PROMPT = [
  "## Tool Name Mapping",
  "You are running inside Claude Code CLI, not OpenClaw.",
  "",
  "### CRITICAL: How to call OpenClaw external tools",
  "When the system prompt lists tools under 'External Tools (Caller Environment)',",
  "you MUST call them using <tool_call> XML blocks in your text output.",
  "The proxy intercepts these blocks and forwards them to OpenClaw for execution.",
  "",
  "NEVER use Bash, Read, or any Claude Code native tool to simulate or replace",
  "external tool calls. Do NOT run `openclaw` CLI commands via Bash.",
  "External tools (exec, process, browser, web_search, web_fetch, image,",
  "memory_search, memory_get, message, cron, sessions_list, sessions_history,",
  "sessions_send, sessions_spawn, sessions_yield, subagents, session_status,",
  "nodes, canvas) can ONLY be invoked via <tool_call> blocks.",
  "",
  "### CRITICAL: After outputting <tool_call> blocks, STOP IMMEDIATELY",
  "Once you output one or more <tool_call> blocks, your turn is OVER.",
  "Do NOT use any Claude Code native tools (Read, Bash, Edit, etc.) after a <tool_call>.",
  "Do NOT output any more text after <tool_call> blocks.",
  "The proxy will kill your process and forward the tool calls to OpenClaw.",
  "",
  "### Claude Code native tools (for local work only)",
  "For local file and code operations, use Claude Code's built-in tools:",
  "- `Read` — read file contents",
  "- `Write` — write files",
  "- `Edit` — edit files",
  "- `Bash` — run local shell commands (NOT for openclaw commands)",
  "- `Grep` — search file contents",
  "- `Glob` — find files by pattern",
  "",
  "### Skills",
  "When a skill says to run a bash/python command, use the `Bash` tool directly.",
  "Skills are located in the `skills/` directory relative to your working directory.",
  "To use a skill: `Read` its SKILL.md file first, then follow the instructions using `Bash`.",
  "Run `openclaw skills list --eligible --json` to see all available skills.",
].join("\n");

/**
 * Strict orchestrator append prompt: Claude Code must not use native tools;
 * OpenClaw executes everything via <tool_call> XML from the request tools list.
 */
const OPENCLAW_TOOL_MAPPING_PROMPT_STRICT = [
  "## OpenClaw orchestrator mode (strict)",
  "",
  "You are the reasoning and planning layer only. OpenClaw (the caller) runs all",
  "actions in the user's environment via <tool_call> XML.",
  "",
  "### Allowed: read-only local inspection only",
  "You MAY use these Claude Code native tools to inspect the local workspace:",
  "`Read`, `Glob`, `Grep` — for context only. Do not use them to perform actions",
  "that should go through OpenClaw tools.",
  "",
  "### FORBIDDEN",
  "- Do NOT invoke Write, Edit, Bash, Task, WebFetch, WebSearch, or any other",
  "  native tool besides Read, Glob, and Grep.",
  "- Do NOT run `openclaw` or other shell commands via Bash.",
  "- Do NOT substitute Bash or file writes for actions that OpenClaw tools can perform.",
  "",
  "### REQUIRED",
  "- Use plain text for reasoning, plans, and short explanations.",
  "- To act on the environment, output ONLY <tool_call>...</tool_call> blocks exactly",
  "  as specified under 'External Tools (Caller Environment)' in the prompt.",
  "- The proxy forwards those blocks to OpenClaw as tool_calls.",
  "- After emitting the <tool_call> blocks needed for this turn, STOP — do not use",
  "  native tools afterward.",
  "",
  "### Skills and workflows",
  "- Use OpenClaw tools and <tool_call> XML only. Do not follow Claude Code's",
  "  skills/ directory or Bash-based skill flows for OpenClaw-equivalent work.",
].join("\n");

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(options);
    const timeout = options.timeout || DEFAULT_TIMEOUT;

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation
        this.process = spawn(process.env.CLAUDE_BIN || "claude", args, {
          cwd: options.cwd || process.cwd(),
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")
          ),
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Set timeout
        this.timeoutId = setTimeout(() => {
          if (!this.isKilled) {
            this.isKilled = true;
            this.process?.kill("SIGTERM");
            this.emit("error", new Error(`Request timed out after ${timeout}ms`));
          }
        }, timeout);

        // Handle spawn errors (e.g., claude not found). Must reject before any
        // resolve(): we previously resolved() immediately, so reject() here
        // was ignored and routes only saw `close` with code -2 (ENOENT).
        this.process.on("error", (err) => {
          this.clearTimeout();
          const wrapped = err.message.includes("ENOENT")
            ? new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            : err;
          reject(wrapped);
        });

        // Resolve only after the OS has successfully spawned the child. If the
        // binary is missing, `error` fires and `spawn` never fires — reject
        // sticks and start().catch() runs before `close` listeners.
        this.process.on("spawn", () => {
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Process spawned with PID: ${this.process?.pid}`);
          }
          // Pass prompt via stdin to avoid E2BIG on large inputs
          this.process!.stdin?.write(prompt);
          this.process!.stdin?.end();
          resolve();
        });

        if (process.env.DEBUG_SUBPROCESS) {
          console.error(`[Subprocess] Spawning Claude CLI...`);
        }

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
          }
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            if (process.env.DEBUG_SUBPROCESS) {
              console.error("[Subprocess stderr]:", errorText.slice(0, 200));
            }
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Process closed with code: ${code}`);
          }
          this.clearTimeout();
          // stream-json lines are usually newline-terminated, but the final
          // line may omit a trailing \n. Without a flush, processBuffer()
          // keeps the last line in `buffer` and never parses it — so `result`
          // never fires and non-streaming requests return 500.
          if (this.buffer.trim()) {
            this.buffer += "\n";
            this.processBuffer();
          }
          // Defer so Promise rejection from spawn `error` is handled (catch
          // microtask) before route `close` handlers — avoids "exited with -2"
          // when the real failure is ENOENT.
          queueMicrotask(() => {
            this.emit("close", code);
          });
        });
      } catch (err) {
        this.clearTimeout();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array
   */
  private buildArgs(options: SubprocessOptions): string[] {
    const args = [
      "--print", // Non-interactive mode
      "--dangerously-skip-permissions", // Skip permission prompts
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--model",
      options.model, // Model alias (opus/sonnet/haiku)
      "--append-system-prompt",
      options.orchestratorStrict
        ? OPENCLAW_TOOL_MAPPING_PROMPT_STRICT
        : OPENCLAW_TOOL_MAPPING_PROMPT,
      // Prompt is passed via stdin (avoids E2BIG on large inputs)
    ];

    if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    // Stateless API: avoid writing session files when no session id. When
    // sessionId is set, allow CLI persistence unless CLAW_PROXY_NO_SESSION_PERSISTENCE.
    const noPersist =
      shouldForceNoSessionPersistence() || !options.sessionId;
    if (noPersist) {
      args.push("--no-session-persistence");
    }

    return args;
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isTextBlockStart(message)) {
          // Emit when a new text content block starts (for inserting separators)
          this.emit("text_block_start", message as ClaudeCliStreamEvent);
        }

        if (isToolUseBlockStart(message)) {
          this.emit("tool_use_start", message as ClaudeCliStreamEvent);
        }

        if (isInputJsonDelta(message)) {
          this.emit("input_json_delta", message as ClaudeCliStreamEvent);
        }

        if (isContentBlockStop(message)) {
          this.emit("content_block_stop", message as ClaudeCliStreamEvent);
        }

        if (isContentDelta(message)) {
          // Emit content delta for streaming (text_delta only)
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimeout();
      this.process.kill(signal);
    }
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.env.CLAUDE_BIN || "claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
