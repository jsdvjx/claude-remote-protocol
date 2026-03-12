/**
 * Claude Code Remote Session — high-level WebSocket session manager.
 *
 * Manages the full lifecycle:
 *  1. Build WS URL: wss://{host}/v1/sessions/ws/{sessionId}/subscribe?organization_uuid={orgUuid}
 *  2. Connect WebSocket transport
 *  3. Send auth message on open
 *  4. Keep-alive every 50s
 *  5. Send/receive newline-delimited JSON messages
 *  6. Handle control requests (tool permissions, hooks, MCP, etc.)
 *  7. Automatic reconnect with exponential backoff (up to 5 retries)
 *  8. Idle timeout after 5 minutes of inactivity
 */

import { WsTransport } from "./transport";
import { ClaudeApi, buildCookie } from "./api";
import type {
  ClaudeRemoteOptions,
  WsServerMessage,
  WsControlRequest,
  WsControlResponse,
  WsResultMessage,
  WsAssistantMessage,
  ControlResponseSuccess,
  ControlResponseError,
  CanUseToolRequest,
  HookCallbackRequest,
  McpMessageRequest,
  InitializeResponse,
  EventMessage,
  ToolPermissionResponse,
} from "./types";

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type ToolPermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
  meta: {
    toolUseID: string;
    signal: AbortSignal;
    suggestions?: unknown[];
  }
) => Promise<ToolPermissionResponse>;

export type HookCallbackHandler = (
  callbackId: string,
  input: unknown,
  toolUseId: string,
  signal: AbortSignal
) => Promise<unknown>;

export interface SessionManagerOptions extends ClaudeRemoteOptions {
  sessionId: string;
  /** Whether to replay missed messages on connect */
  replay?: boolean;
  /** Handle tool permission requests. If not set, all tools are auto-allowed. */
  onToolPermission?: ToolPermissionHandler;
  /** Handle hook callbacks */
  onHookCallback?: HookCallbackHandler;
  /** Called for every assistant message from the server (streaming, may fire multiple times per msg_id) */
  onAssistantMessage?: (message: WsAssistantMessage) => void;
  /** Called when an agent turn completes with execution summary */
  onResult?: (message: WsResultMessage) => void;
  /** Called when connection state changes */
  onStateChange?: (state: ConnectionState) => void;
  /** Called on any error */
  onError?: (error: Error) => void;
  /** Maximum reconnect attempts (default: 5) */
  maxRetries?: number;
  /** Idle timeout in ms (default: 300000 = 5min) */
  idleTimeout?: number;
}

export class SessionManager {
  private transport: WsTransport | null = null;
  private abortController: AbortController | null = null;
  private _state: ConnectionState = "disconnected";
  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageTime = 0;
  private pendingResponses = new Map<
    string,
    (resp: ControlResponseSuccess | ControlResponseError) => void
  >();
  private cancelControllers = new Map<string, AbortController>();
  private initialized = false;
  private initResponse: InitializeResponse | null = null;

  readonly api: ClaudeApi;
  readonly options: SessionManagerOptions;

  get state(): ConnectionState {
    return this._state;
  }

  constructor(options: SessionManagerOptions) {
    this.options = options;
    this.api = new ClaudeApi(options);
  }

  /**
   * Build the WebSocket URL.
   */
  private buildWsUrl(): string {
    const { organizationUuid, sessionId, replay } = this.options;
    const baseUrl = this.options.baseUrl ?? "https://claude.ai";
    const wsHost = this.options.wsHost;

    const path = `/v1/sessions/ws/${sessionId}/subscribe`;
    const params = new URLSearchParams();
    params.append("organization_uuid", organizationUuid);
    if (replay) params.append("replay", "true");

    const qs = params.toString();
    const pathWithQs = qs ? `${path}?${qs}` : path;

    if (wsHost) {
      const host = wsHost.startsWith("ws://") || wsHost.startsWith("wss://")
        ? wsHost
        : `ws://${wsHost}`;
      return `${host}${pathWithQs}`;
    }

    const parsed = new URL(baseUrl);
    const protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${parsed.host}${pathWithQs}`;
  }

  /**
   * Connect to the session WebSocket.
   */
  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") return;

    this.setState("connecting");
    this.abortController = new AbortController();

    const url = this.buildWsUrl();
    const userAgent = this.options.userAgent;
    this.transport = new WsTransport({
      url,
      signal: this.abortController.signal,
      headers: {
        "cookie": buildCookie(this.options),
        "user-agent": userAgent,
        "origin": (this.options.baseUrl ?? "https://claude.ai").replace(/\/$/, ""),
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "ccr-byoc-2025-07-29",
        "anthropic-client-feature": "ccr",
        "anthropic-client-platform": "web_claude_ai",
        "anthropic-client-version": "1.0.0",
        "x-organization-uuid": this.options.organizationUuid,
      },
    });

    try {
      await this.transport.waitReady();
      this.setState("connected");
      this.retryCount = 0;
      this.resetIdleTimer();

      // Start reading messages from WS
      this.readLoop();

      // Send initialize (fire-and-forget with timeout — bridge may not be ready yet)
      const initTimeout = 5000;
      const initPromise = this.sendControlRequest({ subtype: "initialize" })
        .then((resp) => {
          if (resp.subtype === "success") {
            this.initResponse = (resp as ControlResponseSuccess).response as InitializeResponse;
            this.initialized = true;
            const pending = (resp as ControlResponseSuccess).pending_permission_requests;
            if (pending) {
              for (const req of pending) {
                this.handleControlRequest(req);
              }
            }
          }
        })
        .catch(() => { /* initialize may not be supported for this session */ });

      // Wait up to initTimeout for initialize, but don't block connect
      await Promise.race([
        initPromise,
        new Promise<void>((r) => setTimeout(r, initTimeout)),
      ]);
    } catch (err) {
      this.setState("error");
      this.options.onError?.(err as Error);
      this.maybeReconnect(err as Error);
    }
  }

  /**
   * Disconnect from the session.
   */
  disconnect(reason = "user_initiated"): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.abortController?.abort();
    this.transport?.close();
    this.transport = null;
    this.pendingResponses.clear();
    this.cancelControllers.clear();

    if (reason === "user_initiated" || reason === "session_id_changed") {
      this.retryCount = 0;
    }

    this.setState("disconnected");
  }

  /**
   * Send a user message.
   */
  async sendMessage(content: string, fileAttachments?: unknown[]): Promise<void> {
    const uuid = crypto.randomUUID();
    const message: EventMessage = { role: "user", content };
    await this.api.sendMessage({
      sessionId: this.options.sessionId,
      uuid,
      message,
      fileAttachments: fileAttachments as any,
    });
  }

  /**
   * Send an interrupt signal.
   */
  async interrupt(): Promise<void> {
    // Try via WS first (direct SDK interrupt)
    if (this.transport?.isOpen) {
      try {
        await this.sendControlRequest({ subtype: "interrupt" });
        return;
      } catch { /* fall through to HTTP */ }
    }
    await this.api.interrupt(this.options.sessionId);
  }

  /**
   * Set the model for this session.
   */
  async setModel(model: string): Promise<void> {
    await this.sendControlRequest({ subtype: "set_model", model });
  }

  /**
   * Set the permission mode.
   */
  async setPermissionMode(mode: string): Promise<void> {
    await this.sendControlRequest({
      subtype: "set_permission_mode",
      mode,
    });
  }

  /**
   * Set max thinking tokens.
   */
  async setMaxThinkingTokens(tokens: number): Promise<void> {
    await this.sendControlRequest({
      subtype: "set_max_thinking_tokens",
      max_thinking_tokens: tokens,
    });
  }

  /**
   * Get supported slash commands.
   */
  async supportedCommands(): Promise<unknown> {
    return this.initResponse?.commands;
  }

  /**
   * Get MCP server status.
   */
  async mcpServerStatus(): Promise<unknown> {
    const resp = await this.sendControlRequest({ subtype: "mcp_status" });
    return (resp as any)?.response?.mcpServers;
  }

  // --- Internal ---

  private setState(state: ConnectionState) {
    this._state = state;
    this.options.onStateChange?.(state);
  }

  private resetIdleTimer() {
    const timeout = this.options.idleTimeout ?? 300_000;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.disconnect("idle_timeout");
    }, timeout);
  }

  private async readLoop() {
    if (!this.transport) return;

    try {
      for await (const msg of this.transport.readMessages()) {
        this.lastMessageTime = Date.now();
        this.resetIdleTimer();

        // Route message by type
        if (msg.type === "control_response") {
          const resp = msg as WsControlResponse;
          const handler = this.pendingResponses.get(
            resp.response.request_id
          );
          if (handler) {
            handler(resp.response);
            this.pendingResponses.delete(resp.response.request_id);
          }
          continue;
        }

        if (msg.type === "control_request") {
          this.handleControlRequest(msg as WsControlRequest);
          continue;
        }

        if (msg.type === "control_cancel_request") {
          const cancelMsg = msg as any;
          const controller = this.cancelControllers.get(
            cancelMsg.request_id
          );
          if (controller) {
            controller.abort();
            this.cancelControllers.delete(cancelMsg.request_id);
          }
          continue;
        }

        if (msg.type === "keep_alive") continue;

        if (msg.type === "assistant") {
          try { this.options.onAssistantMessage?.(msg as WsAssistantMessage); }
          catch (e) { this.options.onError?.(e as Error); }
          continue;
        }

        if (msg.type === "result") {
          try { this.options.onResult?.(msg as WsResultMessage); }
          catch (e) { this.options.onError?.(e as Error); }
          continue;
        }
      }
    } catch (err) {
      this.options.onError?.(err as Error);
    }

    // Connection ended
    if (this._state === "connected") {
      this.maybeReconnect(
        this.transport?.exitError ?? new Error("Connection lost")
      );
    }
  }

  private async handleControlRequest(msg: WsControlRequest) {
    const ac = new AbortController();
    this.cancelControllers.set(msg.request_id, ac);

    try {
      const result = await this.processControlRequest(msg, ac.signal);
      const response: WsControlResponse = {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: result,
        },
      };
      this.transport?.write(JSON.stringify(response) + "\n");
    } catch (err) {
      const response: WsControlResponse = {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: msg.request_id,
          error: (err as Error).message || String(err),
        },
      };
      this.transport?.write(JSON.stringify(response) + "\n");
    } finally {
      this.cancelControllers.delete(msg.request_id);
    }
  }

  private async processControlRequest(
    msg: WsControlRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    const req = msg.request;

    if (req.subtype === "can_use_tool") {
      const toolReq = req as CanUseToolRequest;
      if (this.options.onToolPermission) {
        return this.options.onToolPermission(
          toolReq.tool_name,
          toolReq.input,
          {
            toolUseID: toolReq.tool_use_id,
            signal,
            suggestions: toolReq.permission_suggestions,
          }
        );
      }
      // Auto-allow if no handler
      return { behavior: "allow", updatedInput: toolReq.input };
    }

    if (req.subtype === "hook_callback") {
      const hookReq = req as HookCallbackRequest;
      if (this.options.onHookCallback) {
        return this.options.onHookCallback(
          hookReq.callback_id,
          hookReq.input,
          hookReq.tool_use_id,
          signal
        );
      }
      return {};
    }

    if (req.subtype === "mcp_message") {
      const mcpReq = req as McpMessageRequest;
      // Forward to onmessage handler if available
      return { mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } };
    }

    throw new Error(`Unsupported control request subtype: ${req.subtype}`);
  }

  private sendControlRequest(
    request: Record<string, unknown>
  ): Promise<ControlResponseSuccess | ControlResponseError> {
    const requestId = Math.random().toString(36).substring(2, 15);
    const msg: WsControlRequest = {
      type: "control_request",
      request_id: requestId,
      request: request as any,
    };

    return new Promise((resolve, reject) => {
      this.pendingResponses.set(requestId, (resp) => {
        if (resp.subtype === "success") {
          resolve(resp);
        } else {
          reject(new Error((resp as ControlResponseError).error));
        }
      });
      this.transport?.write(JSON.stringify(msg) + "\n");
    });
  }

  private maybeReconnect(err: Error) {
    const maxRetries = this.options.maxRetries ?? 5;
    if (this.retryCount >= maxRetries) {
      this.setState("error");
      this.options.onError?.(
        new Error(`Reconnection failed after ${maxRetries} attempts`)
      );
      return;
    }

    this.retryCount++;
    this.setState("reconnecting");

    // Exponential backoff with jitter
    const base = 1000 * Math.pow(2, this.retryCount - 1);
    const jitter = Math.random() * base * 0.5;
    const delay = base + jitter;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
