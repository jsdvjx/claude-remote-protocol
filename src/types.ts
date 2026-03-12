// ============================================================
// Claude Code Remote WebSocket Protocol Types
// Reverse-engineered from claude.ai frontend (2026-03-11)
// ============================================================

// --- HTTP API Headers ---

export interface ClaudeApiHeaders {
  "anthropic-version": "2023-06-01";
  "anthropic-beta": "ccr-byoc-2025-07-29";
  "anthropic-client-feature": "ccr";
  "anthropic-client-platform"?: "web_claude_ai";
  "anthropic-client-version"?: string;
  "x-organization-uuid"?: string;
  "content-type": "application/json";
}

// --- Session Types ---

export type SessionStatus = "active" | "archived" | "idle";
export type SessionType = "internal_session" | "shared_session";

export interface SessionContext {
  allowed_tools: string[];
  disallowed_tools: string[];
  cwd?: string;
  environment_variables: Record<string, string>;
  knowledge_base_ids: string[];
  model: string;
  outcomes: SessionOutcome[];
  sources: SessionSource[];
  custom_system_prompt?: string;
  mcp_config?: McpConfig;
  mcp_tools?: McpTool[];
}

export interface SessionSource {
  type: "git_repository";
  git_info: {
    type: "github";
    repo: string;
    branches: string[];
  };
}

export interface SessionOutcome {
  type: "git_repository";
  git_info: {
    type: "github";
    repo: string;
    branches: string[];
  };
}

export interface McpConfig {
  [serverName: string]: unknown;
}

export interface McpTool {
  name: string;
  server_name: string;
}

export interface Session {
  id: string;
  title: string;
  type: SessionType;
  session_status: SessionStatus;
  environment_id: string;
  active_mount_paths: string[];
  metadata: Record<string, unknown>;
  session_context: SessionContext;
  created_at: string;
  updated_at: string;
}

export interface SessionListResponse {
  data: Session[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
}

export interface CreateSessionParams {
  title?: string;
  environment_id: string;
  events?: SessionEvent[];
  session_context: Partial<SessionContext>;
}

// --- WebSocket URL ---

export interface WsConnectOptions {
  organizationUuid: string;
  sessionId: string;
  replay?: boolean;
}

// --- WebSocket Transport Messages (Newline-delimited JSON) ---

// Direction: Client → Server (sent via WS .send())
// Direction: Server → Client (received via WS onmessage)

// -- Common envelope types --

export type WsClientMessage =
  | WsAuthMessage
  | WsKeepAlive
  | WsControlRequest
  | WsControlResponse
  | WsResultMessage;

export type WsServerMessage =
  | WsKeepAlive
  | WsControlRequest
  | WsControlCancelRequest
  | WsControlResponse
  | WsAssistantMessage
  | WsResultMessage;

// -- Keep alive --

export interface WsKeepAlive {
  type: "keep_alive";
}

// -- Auth message (sent immediately after WS open) --

export interface WsAuthMessage {
  type?: string;
  [key: string]: unknown;
}

// -- Control Request (bidirectional) --

export interface WsControlRequest {
  type: "control_request";
  request_id: string;
  request: ControlRequestPayload;
  /** Present in server→client control requests */
  session_id?: string;
}

export type ControlRequestPayload =
  | InitializeRequest
  | InterruptRequest
  | SetPermissionModeRequest
  | SetModelRequest
  | SetMaxThinkingTokensRequest
  | CanUseToolRequest
  | HookCallbackRequest
  | McpMessageRequest
  | McpStatusRequest;

export interface InitializeRequest {
  subtype: "initialize";
  hooks?: Record<string, HookConfig[]>;
  sdkMcpServers?: string[];
}

export interface InterruptRequest {
  subtype: "interrupt";
}

export interface SetPermissionModeRequest {
  subtype: "set_permission_mode";
  mode: string;
}

export interface SetModelRequest {
  subtype: "set_model";
  model: string;
}

export interface SetMaxThinkingTokensRequest {
  subtype: "set_max_thinking_tokens";
  max_thinking_tokens: number;
}

export interface CanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  tool_use_id: string;
  input: Record<string, unknown>;
  /** Human-readable description of the tool (verified from real traffic) */
  description?: string;
  permission_suggestions?: PermissionSuggestion[];
}

// -- AskUserQuestion types (sent via can_use_tool, verified from real traffic) --

export interface AskUserQuestionOption {
  label: string;
  description: string;
  /** Optional preview content (markdown, rendered in monospace box) */
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  /** Short label for chip/tag display (max 12 chars) */
  header: string;
  options: AskUserQuestionOption[];
  /** If true, user can select multiple options */
  multiSelect: boolean;
}

export interface AskUserQuestionInput {
  questions: AskUserQuestion[];
  /** Populated in the control_response with user's selections */
  answers?: Record<string, string | string[]>;
}

export interface HookCallbackRequest {
  subtype: "hook_callback";
  callback_id: string;
  input: unknown;
  tool_use_id: string;
}

export interface McpMessageRequest {
  subtype: "mcp_message";
  server_name: string;
  message: McpJsonRpcMessage;
}

export interface McpStatusRequest {
  subtype: "mcp_status";
}

export interface HookConfig {
  matcher: unknown;
  hookCallbackIds: string[];
}

export interface PermissionSuggestion {
  type: "replaceRules" | "addRules" | "setMode";
  rules?: Array<{ toolName: string; ruleContent?: string }>;
  behavior?: "allow" | "deny";
  mode?: string;
  destination?: "localSettings" | "session";
}

// -- Control Cancel Request (Server → Client) --

export interface WsControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;
  /** Present in server→client messages */
  session_id?: string;
  created_at?: string;
}

// -- Control Response (bidirectional) --

export interface WsControlResponse {
  type: "control_response";
  response: ControlResponsePayload;
  /** Present in server→client responses */
  session_id?: string;
  created_at?: string;
}

export type ControlResponsePayload =
  | ControlResponseSuccess
  | ControlResponseError;

export interface ControlResponseSuccess {
  subtype: "success";
  request_id: string;
  response: unknown;
  pending_permission_requests?: WsControlRequest[];
}

export interface ControlResponseError {
  subtype: "error";
  request_id: string;
  error: string;
  pending_permission_requests?: WsControlRequest[];
}

// -- Tool permission response --

export interface ToolPermissionResponse {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionSuggestion[];
  toolUseID?: string;
}

// -- Assistant Message (Server → Client, verified from real traffic) --
// Note: Server sends type "assistant" not "result"

export interface WsAssistantMessage {
  type: "assistant";
  session_id: string;
  uuid: string;
  created_at: string;
  parent_tool_use_id: string | null;
  message: AssistantApiMessage;
}

export interface AssistantApiMessage {
  id: string;
  model: string;
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  type: "message";
  usage: MessageUsage;
}

export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
  inference_geo?: string;
  iterations?: unknown[];
  server_tool_use?: {
    web_fetch_requests: number;
    web_search_requests: number;
  };
  service_tier?: string;
  speed?: string;
}

// -- Result Message (Server → Client, verified from real traffic) --
// Sent at the end of a complete agent turn as an execution summary.

export interface WsResultMessage {
  type: "result";
  session_id: string;
  uuid: string;
  created_at: string;
  subtype: "success" | "error";
  result: string;
  /** Total wall-clock duration in ms */
  duration_ms: number;
  /** API call duration in ms */
  duration_api_ms: number;
  /** Number of agent turns */
  num_turns: number;
  /** Total cost in USD */
  total_cost_usd: number;
  is_error: boolean;
  stop_reason: string | null;
  /** Per-model usage breakdown */
  modelUsage: Record<string, unknown>;
  /** List of permission denials during this turn */
  permission_denials: unknown[];
  /** Aggregate token usage */
  usage: MessageUsage;
}

// -- MCP JSON-RPC --

export interface McpJsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// --- HTTP Events API ---

export interface SessionEvent {
  type: "event" | "user" | "assistant" | "system" | "control_request" | "control_response";
  uuid?: string;
  session_id?: string;
  created_at?: string;
  parent_tool_use_id?: string | null;
  message?: EventMessage | AssistantApiMessage;
  data?: unknown;
  request_id?: string;
  request?: ControlRequestPayload;
  response?: ControlResponsePayload;
  file_attachments?: FileAttachment[];
  slash_commands?: SlashCommand[];
  /** Present on tool_result events — metadata about the tool execution */
  tool_use_result?: Record<string, unknown>;
}

export interface EventMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "resource" | "image" | "thinking" | "tool_reference";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  /** Present on tool_use blocks, indicates call origin */
  caller?: { type: string };
  /** Present on thinking blocks — encrypted thinking signature */
  signature?: string;
  /** Present on thinking blocks — the thinking text (may be empty) */
  thinking?: string;
  /** Present on tool_reference blocks — the tool name */
  tool_name?: string;
  [key: string]: unknown;
}

export interface FileAttachment {
  file_name: string;
  file_type: string;
  file_content: string;
}

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface EventsListResponse {
  data: SessionEvent[];
  first_id?: string | null;
  last_id?: string | null;
  has_more: boolean;
}

export interface PostEventsParams {
  sessionId: string;
  events: SessionEvent[];
}

export interface SendMessageParams {
  sessionId: string;
  uuid: string;
  message: EventMessage;
  fileAttachments?: FileAttachment[];
}

// --- Initialize Response ---

export interface InitializeResponse {
  commands?: SlashCommand[];
  models?: string[];
  account?: Record<string, unknown>;
  /** Process ID of the backend agent */
  pid?: number;
  /** Available output styles e.g. ["normal"] */
  available_output_styles?: string[];
  /** Current output style */
  output_style?: string;
}

// --- Client Options ---

// --- Environment Types (verified from real traffic) ---

export type EnvironmentKind = "bridge" | "cloud";
export type EnvironmentState = "active" | "inactive";

export interface Environment {
  kind: EnvironmentKind;
  environment_id: string;
  name: string;
  created_at: string;
  state: EnvironmentState;
  config: unknown | null;
  bridge_info?: BridgeInfo;
}

export interface BridgeInfo {
  max_sessions: number;
  machine_name: string;
  directory: string;
  branch: string | null;
  git_repo_url: string | null;
  online: boolean;
  spawn_mode: string | null;
}

export interface EnvironmentListResponse {
  environments: Environment[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

// --- Client Options ---

export interface ClaudeRemoteOptions {
  /** Organization UUID */
  organizationUuid: string;
  /** Session key (sk-ant-sid02-...) */
  sessionKey: string;
  /** Cloudflare cf_clearance cookie (required to bypass Cloudflare challenge) */
  cfClearance?: string;
  /** Full cookie string override. If provided, sessionKey and cfClearance are ignored. */
  cookie?: string;
  /** Base URL, defaults to https://claude.ai */
  baseUrl?: string;
  /** Custom WS host override (defaults to deriving from baseUrl) */
  wsHost?: string;
  /** User-Agent string (must match the browser that generated cf_clearance cookie) */
  userAgent?: string;
}
