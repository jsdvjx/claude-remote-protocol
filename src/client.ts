/**
 * ClaudeClient — top-level entry point for Claude Code Remote.
 *
 * Pass credentials once, then create/connect to multiple sessions:
 *
 *   const client = new ClaudeClient({ organizationUuid, cookie });
 *   const s1 = await client.connect("session_01...", { onAssistantMessage: ... });
 *   const s2 = await client.create({ environmentId: "env_...", onAssistantMessage: ... });
 *   s1.sendMessage("hello from session 1");
 *   s2.sendMessage("hello from session 2");
 */

import { ClaudeApi } from "./api";
import { SessionManager } from "./session";
import type {
  ClaudeRemoteOptions,
  Session,
  CreateSessionParams,
  SessionListResponse,
  Environment,
  EnvironmentListResponse,
  WsAssistantMessage,
  WsResultMessage,
  SessionContext,
} from "./types";
import type {
  ToolPermissionHandler,
  HookCallbackHandler,
  ConnectionState,
} from "./session";

/** Callbacks for a session — passed to connect() or create() */
export interface SessionCallbacks {
  onAssistantMessage?: (message: WsAssistantMessage) => void;
  onResult?: (message: WsResultMessage) => void;
  onToolPermission?: ToolPermissionHandler;
  onHookCallback?: HookCallbackHandler;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
}

/** Options for connecting to an existing session */
export interface ConnectOptions extends SessionCallbacks {
  replay?: boolean;
  maxRetries?: number;
  idleTimeout?: number;
}

/** Options for creating a new session and connecting */
export interface CreateOptions extends ConnectOptions {
  environmentId?: string;
  title?: string;
  model?: string;
  sessionContext?: Partial<SessionContext>;
}

export class ClaudeClient {
  readonly api: ClaudeApi;
  private readonly credentials: ClaudeRemoteOptions;
  private sessions = new Map<string, SessionManager>();

  constructor(credentials: ClaudeRemoteOptions) {
    this.credentials = credentials;
    this.api = new ClaudeApi(credentials);
  }

  /**
   * Connect to an existing session by ID.
   * Returns a connected SessionManager ready to use.
   */
  async connect(sessionId: string, options: ConnectOptions = {}): Promise<SessionManager> {
    const session = new SessionManager({
      ...this.credentials,
      sessionId,
      replay: options.replay ?? true,
      maxRetries: options.maxRetries,
      idleTimeout: options.idleTimeout,
      onAssistantMessage: options.onAssistantMessage,
      onResult: options.onResult,
      onToolPermission: options.onToolPermission,
      onHookCallback: options.onHookCallback,
      onStateChange: options.onStateChange,
      onError: options.onError,
    });

    await session.connect();
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Create a new session and connect to it.
   *
   * If environmentId is not provided, uses the first active environment.
   */
  async create(options: CreateOptions = {}): Promise<SessionManager> {
    let environmentId = options.environmentId;

    if (!environmentId) {
      const envs = await this.api.listEnvironments();
      const active = envs.environments.find(e => e.state === "active");
      if (!active) {
        throw new Error("No active environment found. Provide environmentId explicitly.");
      }
      environmentId = active.environment_id;
    }

    const params: CreateSessionParams = {
      environment_id: environmentId,
      title: options.title,
      session_context: options.sessionContext ?? {
        model: options.model ?? "claude-sonnet-4-6",
      },
    };

    const created = await this.api.createSession(params);
    return this.connect(created.id, options);
  }

  /**
   * List all sessions.
   */
  async listSessions(): Promise<SessionListResponse> {
    return this.api.listSessions();
  }

  /**
   * Get a specific session by ID.
   */
  async getSession(sessionId: string): Promise<Session> {
    return this.api.getSession(sessionId);
  }

  /**
   * List available environments.
   */
  async listEnvironments(): Promise<EnvironmentListResponse> {
    return this.api.listEnvironments();
  }

  /**
   * Get a connected SessionManager by session ID (if previously connected via this client).
   */
  getConnected(sessionId: string): SessionManager | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Disconnect a specific session.
   */
  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.disconnect();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Disconnect all sessions.
   */
  disconnectAll(): void {
    for (const [id, session] of this.sessions) {
      session.disconnect();
    }
    this.sessions.clear();
  }
}
