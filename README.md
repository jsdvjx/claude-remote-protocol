# claude-remote-protocol

Reverse-engineered TypeScript client for the **Claude Code Remote (CCR)** WebSocket protocol. Built by analyzing live `claude.ai` frontend traffic via Chrome DevTools Protocol.

> **Warning**: This is an unofficial library based on reverse-engineering the undocumented Claude Code Remote protocol. The protocol may change without notice. Use at your own risk.

## Features

- Full WebSocket session management with automatic reconnection
- HTTP REST API client for sessions, events, and environments
- Streaming assistant messages (thinking, text, tool_use)
- Tool permission handling (allow/deny with input modification)
- AskUserQuestion flow (single-select & multi-select)
- Plan mode support (EnterPlanMode / ExitPlanMode)
- MCP server status and message forwarding
- Keep-alive and idle timeout management
- Complete TypeScript types for the entire protocol

## Install

```bash
npm install claude-remote-protocol
```

Requires Node.js >= 18 (uses native `fetch` and `WebSocket`).

> For Node.js < 22 (no native WebSocket), you may need to polyfill `globalThis.WebSocket` with the [`ws`](https://www.npmjs.com/package/ws) package.

## Quick Start

```typescript
import { SessionManager, ClaudeApi } from "claude-remote-protocol";

// 1. Create API client
const api = new ClaudeApi({
  organizationUuid: "your-org-uuid",
  cookie: "sessionKey=sk-ant-...",
});

// 2. List existing sessions
const sessions = await api.listSessions();
console.log(sessions.data);

// 3. Connect to a session via WebSocket
const session = new SessionManager({
  organizationUuid: "your-org-uuid",
  cookie: "sessionKey=sk-ant-...",
  sessionId: "session_01...",

  onAssistantMessage(msg) {
    for (const block of msg.message.content) {
      if (block.type === "text") process.stdout.write(block.text ?? "");
    }
  },

  onResult(msg) {
    console.log(`Done: ${msg.num_turns} turns, $${msg.total_cost_usd}`);
  },

  onToolPermission: async (toolName, input) => {
    // Auto-allow all tools (or implement your own logic)
    return { behavior: "allow", updatedInput: input };
  },
});

await session.connect();

// 4. Send a message
await session.sendMessage("Hello, Claude!");
```

## Architecture

The protocol uses a **dual-channel** design:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| **WebSocket** (`/v1/sessions/ws/{id}/subscribe`) | Server → Client | Streaming responses, control requests |
| **HTTP POST** (`/v1/sessions/{id}/events`) | Client → Server | User messages, tool permissions, interrupts |

Messages on the WebSocket are **newline-delimited JSON**.

### Message Flow

```
Client                          Server
  │                                │
  │──── HTTP POST (user msg) ─────▶│
  │                                │
  │◀──── WS: assistant (stream) ──│  (thinking → text → tool_use)
  │◀──── WS: assistant (stream) ──│  (same msg_id, incremental)
  │◀──── WS: control_request ─────│  (can_use_tool permission)
  │                                │
  │──── WS: control_response ─────▶│  (allow/deny)
  │                                │
  │◀──── WS: assistant (stream) ──│  (tool_result → more text)
  │◀──── WS: result ──────────────│  (execution summary)
```

## API Reference

### `ClaudeApi`

HTTP REST client for session management.

```typescript
const api = new ClaudeApi({
  organizationUuid: string,
  cookie: string,
  baseUrl?: string,  // default: "https://claude.ai"
});

await api.listSessions();
await api.getSession(sessionId);
await api.createSession({ environment_id, session_context });
await api.updateSession(sessionId, { title?, session_status? });
await api.listEvents(sessionId, afterId?);
await api.sendMessage({ sessionId, uuid, message });
await api.interrupt(sessionId);
await api.respondToolPermission({ sessionId, requestId, toolName, decision });
await api.setPermissionMode(sessionId, mode);
await api.listEnvironments();
```

### `SessionManager`

High-level WebSocket session manager.

```typescript
const session = new SessionManager({
  // Required
  organizationUuid: string,
  cookie: string,
  sessionId: string,

  // Optional
  replay?: boolean,           // Replay missed messages on connect
  maxRetries?: number,        // Reconnect attempts (default: 5)
  idleTimeout?: number,       // Idle disconnect in ms (default: 300000)
  baseUrl?: string,
  wsHost?: string,            // Custom WebSocket host

  // Callbacks
  onAssistantMessage?: (msg: WsAssistantMessage) => void,
  onResult?: (msg: WsResultMessage) => void,
  onToolPermission?: ToolPermissionHandler,
  onHookCallback?: HookCallbackHandler,
  onStateChange?: (state: ConnectionState) => void,
  onError?: (error: Error) => void,
});

await session.connect();
await session.sendMessage("Hello!");
await session.interrupt();
await session.setModel("claude-sonnet-4-6");
await session.setPermissionMode("acceptEdits");
await session.setMaxThinkingTokens(10000);
session.disconnect();
```

### Streaming Pattern

Assistant messages arrive incrementally with the same `msg_id`. Content blocks build up over time:

1. First message: `[thinking]`
2. Next: `[thinking, text]`
3. Next: `[thinking, text, tool_use]`
4. Final: `stop_reason` changes from `null` to `"end_turn"` or `"tool_use"`

### Tool Permission Flow

When Claude wants to use a tool, the server sends a `can_use_tool` control request. Your handler decides whether to allow or deny:

```typescript
onToolPermission: async (toolName, input, { toolUseID, signal, suggestions }) => {
  if (toolName === "Bash") {
    return { behavior: "deny", message: "Bash not allowed" };
  }
  return { behavior: "allow", updatedInput: input };
},
```

### Content Block Types

| Type | Fields | Description |
|------|--------|-------------|
| `text` | `text` | Plain text output |
| `thinking` | `thinking`, `signature` | Extended thinking (encrypted signature) |
| `tool_use` | `id`, `name`, `input` | Tool invocation |
| `tool_result` | `tool_use_id`, `content`, `is_error` | Tool execution result |
| `tool_reference` | `tool_name` | Reference to a tool |
| `image` | | Image content |
| `resource` | | Resource reference |

## Protocol Documentation

See [PROTOCOL.md](./PROTOCOL.md) for the complete protocol specification with all message types and flows.

## Authentication

This library requires a valid `claude.ai` session cookie. You can obtain it from your browser's developer tools:

1. Open `claude.ai` and log in
2. Open DevTools → Application → Cookies
3. Copy the cookie string (specifically `sessionKey`)
4. Find your organization UUID from any API request in the Network tab (`x-organization-uuid` header)

## License

MIT
