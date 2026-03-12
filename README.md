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
import { ClaudeClient } from "claude-remote-protocol";

// 1. Create client (pass credentials once)
const client = new ClaudeClient({
  organizationUuid: "your-org-uuid",
  sessionKey: "sk-ant-sid02-...",
  cfClearance: "...",
  userAgent: "Mozilla/5.0 ...",
});

// 2. Connect to an existing session
const session = await client.connect("session_01...", {
  onAssistantMessage(msg) {
    for (const block of msg.message.content) {
      if (block.type === "text") process.stdout.write(block.text ?? "");
    }
  },
  onResult(msg) {
    console.log(`Done: ${msg.num_turns} turns, $${msg.total_cost_usd}`);
  },
});

await session.sendMessage("Hello, Claude!");

// 3. Or create a new session (auto-selects active environment)
const newSession = await client.create({
  model: "claude-sonnet-4-6",
  title: "My Task",
  onAssistantMessage(msg) { /* ... */ },
});

await newSession.sendMessage("Start working on the task.");

// 4. Multiple sessions in parallel
const [s1, s2] = await Promise.all([
  client.connect("session_A", { onResult(m) { console.log("A done"); } }),
  client.connect("session_B", { onResult(m) { console.log("B done"); } }),
]);

// 5. Cleanup
client.disconnectAll();
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

### `ClaudeClient`

Top-level entry point. Pass credentials once, manage multiple sessions.

```typescript
const client = new ClaudeClient({
  organizationUuid: string,
  sessionKey: string,          // sk-ant-sid02-...
  cfClearance: string,         // Cloudflare cf_clearance cookie
  userAgent: string,           // must match browser that generated cfClearance
  cookie?: string,             // full cookie override (sessionKey/cfClearance ignored)
  baseUrl?: string,            // default: "https://claude.ai"
});

// Connect to existing session (returns connected SessionManager)
const session = await client.connect(sessionId, {
  replay?: boolean,
  maxRetries?: number,
  idleTimeout?: number,
  onAssistantMessage?, onResult?, onToolPermission?, onError?,
});

// Create new session + connect (auto-selects environment if omitted)
const session = await client.create({
  environmentId?: string,
  model?: string,           // default: "claude-sonnet-4-6"
  title?: string,
  sessionContext?: Partial<SessionContext>,
  // ...same callbacks as connect
});

await client.listSessions();
await client.listEnvironments();
client.getConnected(sessionId);   // get a previously connected session
client.disconnect(sessionId);     // disconnect one
client.disconnectAll();           // disconnect all
```

### `ClaudeApi`

HTTP REST client for session management (also accessible via `client.api`).

```typescript
const api = new ClaudeApi({
  organizationUuid: string,
  sessionKey: string,
  cfClearance: string,
  userAgent: string,
  cookie?: string,             // full cookie override
  baseUrl?: string,
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
  sessionKey: string,
  cfClearance: string,
  userAgent: string,
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

You need three things from your `claude.ai` browser session:

1. **`sessionKey`** — DevTools → Application → Cookies → `sessionKey` (`sk-ant-sid02-...`)
2. **`organizationUuid`** — Network tab → any API request → `x-organization-uuid` header
3. **`cfClearance`** — DevTools → Application → Cookies → `cf_clearance`
4. **`userAgent`** — Console → `navigator.userAgent` (must match the browser that generated `cfClearance`)

```typescript
const client = new ClaudeClient({
  organizationUuid: "ed81b697-...",
  sessionKey: "sk-ant-sid02-...",
  cfClearance: "DrW9nrPr...",
  userAgent: "Mozilla/5.0 ...",
});
```

## License

MIT
