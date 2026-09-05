/**
 * In orchestrator strict mode, Claude Code native tool_use is normally blocked so
 * the caller executes via <tool_call> XML only. Read-only local tools (Read, Glob,
 * Grep) are allowed — they help the model inspect the workspace without
 * substituting for caller actions.
 */

/**
 * Lowercase — CLI may emit PascalCase or other casing.
 *
 * Two categories are allowed:
 *  - Local read-only inspection: read, glob, grep.
 *  - Harness-internal bookkeeping that has no effect on the user's environment:
 *    toolsearch (capability discovery) and todowrite (the CLI's own task list).
 *
 * The harness-internal ones matter: Claude Code frequently emits ToolSearch as
 * its *first* action to discover available tools. Blocking it killed the
 * subprocess before any text or <tool_call> was produced, so the turn finalized
 * empty (0 tool calls, finish_reason=stop) and the caller saw a silent success.
 */
const READ_ONLY_NATIVE_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "toolsearch",
  "todowrite",
]);

export function isOrchestratorStrictNativeToolAllowed(toolName: string): boolean {
  return READ_ONLY_NATIVE_TOOLS.has(toolName.trim().toLowerCase());
}
