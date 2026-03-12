# Claude Code Remote WebSocket Protocol

Reverse-engineered from `claude.ai` frontend on 2026-03-11.

## Overview

Claude Code Remote uses a dual-channel architecture:
- **WebSocket** for real-time streaming (subscribe to session events)
- **HTTP REST API** for session management and sending events

## Authentication

All requests require:
- Browser session cookie (contains `sessionKey`)
- Custom headers (verified from real traffic):
  ```
  anthropic-version: 2023-06-01
  anthropic-beta: ccr-byoc-2025-07-29
  anthropic-client-feature: ccr
  anthropic-client-platform: web_claude_ai
  anthropic-client-version: 1.0.0
  x-organization-uuid: {orgUuid}
  content-type: application/json
  ```
- Optional headers observed in real traffic:
  ```
  anthropic-anonymous-id: claudeai.v1.{uuid}
  anthropic-device-id: {uuid}
  anthropic-client-sha: {git_sha}
  ```

## REST API Endpoints

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/sessions` | List sessions |
| `POST` | `/v1/sessions` | Create session |
| `GET` | `/v1/sessions/{id}` | Get session details |
| `PATCH` | `/v1/sessions/{id}` | Update session (title, status) |

#### Create Session Body
```json
{
  "title": "My session",
  "environment_id": "env_...",
  "events": [{ "type": "event", "data": {...} }],
  "session_context": {
    "model": "claude-sonnet-4-6",
    "sources": [{ "type": "git_repository", "git_info": { "type": "github", "repo": "owner/repo", "branches": ["main"] } }],
    "outcomes": [...],
    "mcp_config": {...},
    "mcp_tools": [...],
    "custom_system_prompt": "..."
  }
}
```

#### Session Status Values
- `active` — session is running
- `archived` — session completed
- `idle` — session idle/paused

### Events

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/sessions/{id}/events` | List events (paginated via `?after_id=`) |
| `POST` | `/v1/sessions/{id}/events` | Post events |
| `GET` | `/v1/sessions/{id}/share-status` | Get session share status |

#### User Message Event (verified from real traffic)
```json
{
  "events": [{
    "type": "user",
    "uuid": "random-uuid",
    "session_id": "session_01...",
    "parent_tool_use_id": null,
    "message": { "role": "user", "content": "Hello" },
    "file_attachments": [{ "file_name": "...", "file_type": "...", "file_content": "..." }]
  }]
}
```

#### Interrupt Event
```json
{
  "events": [{
    "type": "control_request",
    "request_id": "interrupt-1710...-abc123",
    "request": { "subtype": "interrupt" }
  }]
}
```

#### Tool Permission Response Event
```json
{
  "events": [{
    "type": "control_response",
    "response": {
      "subtype": "success",
      "request_id": "...",
      "response": {
        "behavior": "allow",
        "updatedInput": {...},
        "toolUseID": "..."
      }
    }
  }]
}
```

#### Set Permission Mode Event
```json
{
  "events": [{
    "type": "control_request",
    "request_id": "perm-...",
    "request": { "subtype": "set_permission_mode", "mode": "plan" }
  }]
}
```

### Environments

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/environment_providers/private/organizations/{orgId}/environments` | List environments |
| `GET` | `/v1/environment_providers/private/organizations/{orgId}/environments/{envId}` | Get environment details |

---

## WebSocket Protocol

### Connection

**URL:** `wss://{host}/v1/sessions/ws/{sessionId}/subscribe?organization_uuid={orgUuid}[&replay=true]`

- `replay=true` re-sends missed messages since last disconnect

### Message Format

All messages are **newline-delimited JSON** (`\n` separator). Each line is a complete JSON object.

### Connection Lifecycle

1. **Connect** — open WebSocket to the URL
2. **Auth** — (optional) send auth message JSON + `\n`
3. **Keep-alive** — client sends `{"type":"keep_alive"}\n` every 50 seconds
4. **Timeout** — connection considered failed after 5 seconds with no `onopen`
5. **Reconnect** — exponential backoff: `2^attempt * 1000ms + random jitter`, up to 5 retries
6. **Idle disconnect** — after 5 minutes of no messages, client disconnects

### Message Types

#### `keep_alive`
Heartbeat in both directions.
```json
{"type": "keep_alive"}
```

#### `assistant` (Server→Client, verified from real traffic)
Server sends assistant messages containing model output (text, tool_use blocks).
```json
{
  "type": "assistant",
  "session_id": "session_01...",
  "uuid": "evt_...",
  "created_at": "2026-03-11T...",
  "parent_tool_use_id": null,
  "message": {
    "id": "msg_...",
    "model": "claude-opus-4-6",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "toolu_...", "name": "Read", "input": {...}, "caller": { "type": "direct" } }
    ],
    "stop_reason": "tool_use",
    "stop_sequence": null,
    "type": "message",
    "usage": {
      "input_tokens": 12345,
      "output_tokens": 678,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 9000,
      "cache_creation": { "ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 1234 },
      "inference_geo": "us",
      "service_tier": "standard",
      "speed": "fast"
    }
  }
}
```

**Streaming:** The same `msg_id` is sent multiple times as content is generated:
1. First message: `thinking` block, `stop_reason: null`
2. Next: `text` block, `stop_reason: null`
3. Final: `tool_use` block, `stop_reason: "tool_use"` (or `"end_turn"`)

Each incremental message replaces the previous content for that block type. The `usage` field is updated incrementally.

#### `result` (Server→Client, verified from real traffic)
Sent at the end of a complete agent turn as an execution summary:
```json
{
  "type": "result",
  "session_id": "session_01...",
  "created_at": "2026-03-12T...",
  "subtype": "success",
  "result": "",
  "duration_ms": 0,
  "duration_api_ms": 0,
  "num_turns": 0,
  "total_cost_usd": 0,
  "is_error": false,
  "stop_reason": null,
  "modelUsage": {},
  "permission_denials": [],
  "usage": { ... }
}
```

**Content block types observed in real traffic:**
- `text` — plain text output
- `tool_use` — tool call with `name`, `input`, `caller: { type: "direct" }`
- `tool_result` — tool execution result with `content` (string or nested blocks)
- `thinking` — extended thinking block with `signature` (encrypted) and `thinking` (may be empty string)
- `tool_reference` — reference to a deferred tool, contains `tool_name`

**`user` messages include extra metadata:**
- `tool_use_result` — object with metadata about tool execution (e.g., `matches`, `query` for ToolSearch; `answers`, `questions` for AskUserQuestion; `backgroundTaskId` for Bash background tasks)

#### `control_request` (bidirectional)
Used for SDK initialization, tool permissions, hooks, MCP, model changes, etc.
```json
{
  "type": "control_request",
  "request_id": "abc123",
  "request": {
    "subtype": "...",
    ...
  }
}
```

**Control Request Subtypes:**

| Subtype | Direction | Description |
|---------|-----------|-------------|
| `initialize` | Client→Server | Initialize SDK with hooks & MCP servers. Returns `{commands, models, account}` |
| `interrupt` | Client→Server | Interrupt current execution |
| `set_permission_mode` | Client→Server | Set permission mode (`"default"`, `"plan"`, etc.) |
| `set_model` | Client→Server | Switch model |
| `set_max_thinking_tokens` | Client→Server | Set thinking budget |
| `mcp_status` | Client→Server | Get MCP server statuses |
| `can_use_tool` | Server→Client | Ask client for tool permission |
| `hook_callback` | Server→Client | Execute a hook callback |
| `mcp_message` | Server→Client | Forward MCP JSON-RPC message |

#### `control_response` (bidirectional)
Response to a `control_request`.

**Success:**
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "abc123",
    "response": { ... }
  }
}
```

**Error:**
```json
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "abc123",
    "error": "Error message"
  }
}
```

Successful responses may include `pending_permission_requests` — an array of pending `can_use_tool` control requests the client should process.

#### `control_cancel_request` (Server→Client)
Cancel a pending control request.
```json
{
  "type": "control_cancel_request",
  "request_id": "abc123"
}
```

### Tool Permission Flow (verified from real traffic)

1. Server sends `control_request` via **WS** with `subtype: "can_use_tool"`, `tool_name`, `tool_use_id`, `input`, `description`
2. Client responds via **HTTP POST** `/v1/sessions/{id}/events` (NOT via WS!) with:
   ```json
   {
     "events": [{
       "type": "control_response",
       "response": {
         "subtype": "success",
         "request_id": "toolu_01...",
         "response": {
           "toolUseID": "toolu_01...",
           "behavior": "allow",
           "updatedInput": { ... }
         }
       }
     }]
   }
   ```
3. Response fields:
   - `behavior: "allow"` or `"deny"`
   - `updatedInput` — optionally modified input (for AskUserQuestion, includes `answers`)
   - `toolUseID` — echoes the tool_use_id
   - `message` — denial reason (for deny)
   - `updatedPermissions` — permission rule changes:
     ```json
     [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "bun run tsc"}], "behavior": "allow", "destination": "localSettings"}]
     ```
   - Permission types: `replaceRules`, `addRules`, `setMode`

**Important:** `set_permission_mode` is also sent via HTTP POST events, not WS:
```json
{"events":[{"type":"control_request","request_id":"set-perm-mode-...","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}]}
```

### AskUserQuestion Flow (verified from real traffic)

`AskUserQuestion` reuses the `can_use_tool` permission flow. The complete sequence:

**1. Server sends `control_request`:**
```json
{
  "type": "control_request",
  "request_id": "d80cd902-...",
  "session_id": "session_01...",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "AskUserQuestion",
    "tool_use_id": "toolu_01...",
    "description": "Asks the user multiple choice questions...",
    "input": {
      "questions": [
        {
          "question": "Which approach?",
          "header": "Approach",
          "multiSelect": false,
          "options": [
            { "label": "Option A (Recommended)", "description": "...", "preview": "code preview..." },
            { "label": "Option B", "description": "..." }
          ]
        },
        {
          "question": "Which features?",
          "header": "Features",
          "multiSelect": true,
          "options": [
            { "label": "Logging", "description": "..." },
            { "label": "Metrics", "description": "..." }
          ]
        }
      ]
    }
  }
}
```

**2. Server also sends `assistant` message with `tool_use` block** (same `tool_use_id`)

**3. Client sends `control_response` with user selections:**
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "d80cd902-...",
    "response": {
      "behavior": "allow",
      "updatedInput": {
        "questions": [...],
        "answers": {
          "Which approach?": "Option A",
          "Which features?": ["Logging", "Metrics"]
        }
      }
    }
  }
}
```

**Key:** Single-select answers are `string`, multi-select answers are `string[]`.

**4. Server sends `tool_result`** with `tool_use_result.answers` confirming selections.

### EnterPlanMode / ExitPlanMode Flow

These are also regular tools sent via `tool_use` content blocks:
- `EnterPlanMode`: `{ "name": "EnterPlanMode", "input": {} }` — enters read-only planning phase
- `ExitPlanMode`: `{ "name": "ExitPlanMode", "input": {} }` — exits planning, requests user approval
- Both go through the `can_use_tool` permission flow if permissions are not skipped

### Initialize Flow

Client sends immediately after WS open (verified from real traffic):
```json
{"request_id":"ocg3n6ewj7k","type":"control_request","request":{"subtype":"initialize"}}
```

Note: The web client sends a minimal initialize. SDK clients may include additional fields:
```json
{
  "type": "control_request",
  "request_id": "...",
  "request": {
    "subtype": "initialize",
    "hooks": { "eventName": [{ "matcher": ..., "hookCallbackIds": ["hook_0"] }] },
    "sdkMcpServers": ["server1"]
  }
}
```

Server responds with (verified from real traffic):
```json
{
  "type": "control_response",
  "session_id": "session_01...",
  "created_at": "2026-03-11T...",
  "response": {
    "subtype": "success",
    "request_id": "...",
    "response": {
      "account": {},
      "available_output_styles": ["normal"],
      "commands": [],
      "models": [],
      "output_style": "normal",
      "pid": 55612
    }
  }
}
```

### MCP Message Forwarding

For SDK-side MCP servers, server sends:
```json
{
  "type": "control_request",
  "request_id": "...",
  "request": {
    "subtype": "mcp_message",
    "server_name": "my-server",
    "message": { "jsonrpc": "2.0", "method": "...", "params": {...}, "id": 1 }
  }
}
```

Client forwards to local MCP server and responds with:
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "...",
    "response": {
      "mcp_response": { "jsonrpc": "2.0", "result": {...}, "id": 1 }
    }
  }
}
```

---

## Session Page Load Sequence (verified from real traffic)

When the web UI loads a session page, the following requests are made in order:

1. `GET /v1/sessions` — list all sessions (for sidebar)
2. `GET /v1/environment_providers/private/organizations/{orgId}/environments` — list environments
3. `GET /v1/sessions/{id}` — get session details
4. `GET /v1/sessions/{id}/share-status` — check if shared
5. `GET /v1/sessions/{id}/events` — load initial events
6. `GET /v1/environment_providers/private/organizations/{orgId}/environments/{envId}` — get env details
7. **WebSocket connect** → `wss://claude.ai/v1/sessions/ws/{id}/subscribe?organization_uuid={orgUuid}`
8. Client sends `{"request_id":"...","type":"control_request","request":{"subtype":"initialize"}}\n`
9. If session was active, recovery: `GET /v1/sessions/{id}/events` (paginated with `?after_id=`)
10. Messages sent via: `POST /v1/sessions/{id}/events` (HTTP, not WS)

### Analytics Events Observed

The web client sends analytics to `POST https://a-api.anthropic.com/v1/t`:
- `claudeai.session.recovery_attempted` — when reconnecting to an active session
- `claudeai.session.disconnecting` — when WS is disconnecting
- `claudeai.session.connecting` — when WS is reconnecting
- `claudeai.session.disconnected_due_to_error` — when WS fails
- `claudeai.cumulative_error_count` — periodic error count report

### Environment Response Format (verified)

```json
{
  "environments": [{
    "kind": "bridge",
    "environment_id": "env_01...",
    "name": "MACHINE:C:\\path:9fd9",
    "created_at": "2026-03-11T14:42:56.620319Z",
    "state": "active",
    "config": null,
    "bridge_info": {
      "max_sessions": 1,
      "machine_name": "TEDDYSUN",
      "directory": "C:\\Users\\Administrator\\claude-agent",
      "branch": "HEAD",
      "git_repo_url": null,
      "online": true,
      "spawn_mode": null
    }
  }],
  "has_more": false,
  "first_id": "env_01...",
  "last_id": "env_01..."
}
```
