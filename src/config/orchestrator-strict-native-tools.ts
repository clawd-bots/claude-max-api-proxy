/**
 * In orchestrator strict mode, Claude Code native tool_use is normally blocked so
 * OpenClaw executes via <tool_call> XML only. Read-only local tools (Read, Glob,
 * Grep) are allowed — they help the model inspect the workspace without
 * substituting for OpenClaw actions.
 */

/** Lowercase — CLI may emit PascalCase or other casing */
const READ_ONLY_NATIVE_TOOLS = new Set(["read", "glob", "grep"]);

export function isOrchestratorStrictNativeToolAllowed(toolName: string): boolean {
  return READ_ONLY_NATIVE_TOOLS.has(toolName.trim().toLowerCase());
}
