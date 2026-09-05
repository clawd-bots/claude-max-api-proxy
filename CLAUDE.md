# Claude Max API Proxy

OpenAI-compatible API proxy that wraps the Claude Code CLI.

## Build

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode for development
```

## Environment

> **Prefix renamed.** These flags used to be prefixed `CLAW_PROXY_` (after
> OpenClaw, the retired agent framework). They are now `CLAUDE_MAX_PROXY_`,
> named for this project rather than for whichever caller sits in front of it.
> The old names still resolve via `src/config/env.ts` and log a one-time
> deprecation warning to stderr.


| Variable | Description |
|----------|-------------|
| `CLAUDE_MAX_PROXY_ORCHESTRATOR_STRICT` | Set to `1`, `true`, or `yes` for caller-first strict mode (requires non-empty `tools` on chat requests). **Required for agent-framework callers such as Hermes** — see below. |
| `CLAUDE_MAX_PROXY_SKIP_PERMISSIONS` | Set to `1`, `true`, or `yes` to pass `--dangerously-skip-permissions` to the spawned CLI. **Defaults to off.** Strict mode already blocks mutating native tools at the proxy layer, so this is not needed for the normal path. |

### Why strict mode is required for agent callers

In **default** (non-strict) mode the appended system prompt tells the CLI session
that its own native tools are first-class: *"Only use these external tools when
your built-in tools (Read, Bash, Edit, etc.) cannot accomplish the task."* The
session obeys — it runs `Bash`/`Write`/`Edit` locally instead of emitting
`<tool_call>` blocks. The proxy then detects a "native tool loop", kills the
subprocess, and finalizes with **0 tool calls and `finish_reason=stop`**. The
caller receives an HTTP 200 with empty content and reads it as a successful
empty reply, so provider fallback never fires.

Strict mode fixes this by blocking non-read-only native tools and forcing all
action through `<tool_call>`. Note that the strict allowlist must include the
CLI's harness-internal tools (`ToolSearch`, `TodoWrite`) — Claude Code often
emits `ToolSearch` as its *first* action, and blocking it kills the turn before
any output. See `src/config/orchestrator-strict-native-tools.ts`.
| `CLAUDE_MAX_PROXY_LOG_REQUESTS` | Set to `1`, `true`, or `yes` to log each chat request (model, lengths, session id, first 2000 chars of the CLI prompt) to stderr. |
| `CLAUDE_MAX_PROXY_NO_SESSION_PERSISTENCE` | Set to `1`, `true`, or `yes` to always pass `--no-session-persistence` to the CLI, even when a session id is resolved. |

### Claude CLI session id (multi-turn)

The proxy passes `--session-id` to the CLI when a session key is resolved from (first match wins): `metadata.conversation_id` / `metadata.session_id` / `metadata.thread_id`, JSON `session_id`, `claude_session_id`, `conversation_id`, `thread_id`, OpenAI `user`, or headers `X-Session-Id` / `X-Claude-Session-Id`. Values that are not already CLI-style UUIDs are mapped through the on-disk session map (`src/session/manager.ts`) to a stable Claude session id. If none are set, the CLI runs with `--no-session-persistence` (stateless).

Set these with `Environment=` lines in the systemd unit (see Service Management), or export them in the shell before `npm start` if not using the service.

## Service Management

On the Hetzner VPS the proxy runs as a **systemd --user** service on port 3456.

**Unit:** `~/.config/systemd/user/claude-max-api.service`
**Logs:** `journalctl --user -u claude-max-api -f`

The global `claude-max-api` binary is npm-linked directly into this repo's
`dist/`, so `npx tsc` here updates what the service runs — followed by a restart.

```bash
npx tsc                                   # build
systemctl --user restart claude-max-api   # restart
systemctl --user status claude-max-api    # status
systemctl --user daemon-reload            # after editing the unit file
```

The unit sets `CLAUDE_MAX_PROXY_ORCHESTRATOR_STRICT=1` (required — see Environment
above) and a `WorkingDirectory` of `~/.hermes/claude-max-workspace`, so the
spawned CLI's read tools are scoped to a dedicated directory rather than `$HOME`.

> A Hermes cron job (`claude-max-health`, every 10m) probes `/v1/models` and
> **restarts this service automatically** if it is down — so stopping it by hand
> only holds for up to 10 minutes. Pause that job first if you need it down.

### macOS (original upstream setup)

Upstream ran this as a LaunchAgent
(`~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`, managed with
`launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy`). That path
is not used on this machine.

## Architecture

- `src/config/orchestrator.ts` - `CLAUDE_MAX_PROXY_ORCHESTRATOR_STRICT` / `shouldEnforceOrchestratorStrict`
- `src/config/orchestrator-strict-native-tools.ts` - native tools allowed in strict mode (read-only + harness-internal)
- `src/config/permissions.ts` - `CLAUDE_MAX_PROXY_SKIP_PERMISSIONS` / `shouldSkipPermissions`
- `src/config/session-cli.ts` - `CLAUDE_MAX_PROXY_NO_SESSION_PERSISTENCE`
- `src/config/request-log.ts` - `CLAUDE_MAX_PROXY_LOG_REQUESTS`
- `src/types/claude-cli.ts` - Claude CLI JSON streaming types and type guards
- `src/types/openai.ts` - OpenAI-compatible API types
- `src/adapter/openai-to-cli.ts` - Converts OpenAI requests to CLI input
- `src/adapter/cli-to-openai.ts` - Converts CLI output to OpenAI responses
- `src/subprocess/manager.ts` - Spawns and manages Claude CLI subprocesses
- `src/server/routes.ts` - Express route handlers (streaming + non-streaming)
- `src/server/standalone.js` - Server entry point
