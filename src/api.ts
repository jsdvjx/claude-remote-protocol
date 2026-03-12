/**
 * Claude Code Remote HTTP API client.
 *
 * REST endpoints:
 *  - GET    /v1/sessions                                     → list sessions
 *  - POST   /v1/sessions                                     → create session
 *  - GET    /v1/sessions/{id}                                → get session
 *  - PATCH  /v1/sessions/{id}                                → update session (title, status)
 *  - GET    /v1/sessions/{id}/events                         → list events (paginated)
 *  - POST   /v1/sessions/{id}/events                         → post events (send message, control)
 *  - GET    /v1/sessions/{id}/share-status                    → get share status
 *  - GET    /v1/environment_providers/private/organizations/{orgId}/environments → list environments
 *  - GET    /v1/environment_providers/private/organizations/{orgId}/environments/{envId} → get environment
 */

import type {
  ClaudeRemoteOptions,
  Session,
  SessionListResponse,
  CreateSessionParams,
  EventsListResponse,
  SessionEvent,
  EventMessage,
  FileAttachment,
  EnvironmentListResponse,
} from "./types";

/** Build cookie string from options */
export function buildCookie(options: ClaudeRemoteOptions): string {
  if (options.cookie) return options.cookie;
  const parts = [`sessionKey=${options.sessionKey}`];
  if (options.cfClearance) parts.push(`cf_clearance=${options.cfClearance}`);
  return parts.join("; ");
}

export class ClaudeApi {
  private baseUrl: string;
  private orgUuid: string;
  private cookie: string;
  private userAgent: string;

  constructor(options: ClaudeRemoteOptions) {
    this.baseUrl = (options.baseUrl ?? "https://claude.ai").replace(/\/$/, "");
    this.orgUuid = options.organizationUuid;
    this.cookie = buildCookie(options);
    this.userAgent = options.userAgent ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "ccr-byoc-2025-07-29",
      "anthropic-client-feature": "ccr",
      "anthropic-client-platform": "web_claude_ai",
      "anthropic-client-version": "1.0.0",
      "x-organization-uuid": this.orgUuid,
      "user-agent": this.userAgent,
      cookie: this.cookie,
    };
  }

  private async request<T>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      ...init,
      headers: {
        ...this.headers(),
        ...(init?.headers ?? {}),
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new ApiError(resp.status, body, url);
    }
    return resp.json() as Promise<T>;
  }

  // --- Sessions ---

  async listSessions(): Promise<SessionListResponse> {
    return this.request("/v1/sessions");
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.request(`/v1/sessions/${sessionId}`);
  }

  async createSession(params: CreateSessionParams): Promise<Session> {
    return this.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async updateSession(
    sessionId: string,
    update: { title?: string; session_status?: string }
  ): Promise<Session> {
    return this.request(`/v1/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(update),
    });
  }

  // --- Events ---

  async listEvents(
    sessionId: string,
    afterId?: string
  ): Promise<EventsListResponse> {
    const params = afterId ? `?after_id=${afterId}` : "";
    return this.request(`/v1/sessions/${sessionId}/events${params}`);
  }

  async postEvents(
    sessionId: string,
    events: SessionEvent[]
  ): Promise<void> {
    await this.request(`/v1/sessions/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({ events }),
    });
  }

  /**
   * Send a user message to a session via the events API.
   */
  async sendMessage(params: {
    sessionId: string;
    uuid: string;
    message: EventMessage;
    parentToolUseId?: string | null;
    fileAttachments?: FileAttachment[];
  }): Promise<void> {
    const event: SessionEvent = {
      type: "user",
      uuid: params.uuid,
      session_id: params.sessionId,
      parent_tool_use_id: params.parentToolUseId ?? null,
      message: params.message,
      ...(params.fileAttachments && params.fileAttachments.length > 0
        ? { file_attachments: params.fileAttachments }
        : {}),
    };
    await this.postEvents(params.sessionId, [event]);
  }

  // --- Share Status ---

  async getShareStatus(sessionId: string): Promise<unknown> {
    return this.request(`/v1/sessions/${sessionId}/share-status`);
  }

  // --- Environments ---

  async getEnvironment(envId: string): Promise<unknown> {
    return this.request(
      `/v1/environment_providers/private/organizations/${this.orgUuid}/environments/${envId}`
    );
  }

  /**
   * Send an interrupt control request via the events API.
   */
  async interrupt(sessionId: string): Promise<void> {
    const requestId = `interrupt-${Date.now()}-${Math.random()
      .toString(36)
      .substring(7)}`;
    await this.postEvents(sessionId, [
      {
        type: "control_request",
        request_id: requestId,
        request: { subtype: "interrupt" },
      },
    ]);
  }

  /**
   * Send a tool permission response via the events API.
   */
  async respondToolPermission(params: {
    sessionId: string;
    requestId: string;
    toolName: string;
    toolUseId?: string;
    decision: "allow" | "deny";
    input?: Record<string, unknown>;
    suggestions?: unknown[];
  }): Promise<void> {
    const response: Record<string, unknown> = {
      behavior: params.decision,
      toolUseID: params.toolUseId,
    };
    if (params.decision === "deny") {
      response.message = "Denied by user";
    } else {
      if (params.input) response.updatedInput = params.input;
    }

    await this.postEvents(params.sessionId, [
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: params.requestId,
          response,
        },
      },
    ]);
  }

  /**
   * Set permission mode for a session via the events API.
   */
  async setPermissionMode(
    sessionId: string,
    mode: string
  ): Promise<void> {
    const requestId = `perm-${Date.now()}-${Math.random()
      .toString(36)
      .substring(7)}`;
    await this.postEvents(sessionId, [
      {
        type: "control_request",
        request_id: requestId,
        request: { subtype: "set_permission_mode", mode },
      },
    ]);
  }

  // --- Environments ---

  async listEnvironments(): Promise<EnvironmentListResponse> {
    return this.request(
      `/v1/environment_providers/private/organizations/${this.orgUuid}/environments`
    );
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string
  ) {
    super(`API ${status} for ${url}: ${body}`);
    this.name = "ApiError";
  }
}
