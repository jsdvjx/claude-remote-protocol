/**
 * WebSocket Transport for Claude Code Remote protocol.
 *
 * Protocol details:
 *  - URL: wss://{host}/v1/sessions/ws/{sessionId}/subscribe?organization_uuid={orgUuid}[&replay=true]
 *  - Messages are newline-delimited JSON (\n separated)
 *  - On open: optionally send authMessage + \n
 *  - Keep-alive: client sends {"type":"keep_alive"}\n every 50s
 *  - Connection timeout: 5s
 *  - Reconnect: exponential backoff up to 5 retries
 */

import WebSocket from "ws";
import type { WsAuthMessage, WsServerMessage, WsKeepAlive } from "./types";

export interface TransportOptions {
  url: string;
  authMessage?: WsAuthMessage;
  signal?: AbortSignal;
  /** Custom headers for the WebSocket upgrade request (cookie, user-agent, etc.) */
  headers?: Record<string, string>;
}

export type TransportState = "connecting" | "connected" | "disconnected" | "error";

export class WsTransport {
  private ws: WebSocket | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private messageQueue: WsServerMessage[] = [];
  private messageResolve: ((msg: IteratorResult<WsServerMessage>) => void) | null = null;
  private _state: TransportState = "disconnected";
  private _exitError: Error | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyPromise: Promise<void>;
  private abortHandler: (() => void) | null = null;
  private closed = false;

  readonly options: TransportOptions;

  get state(): TransportState {
    return this._state;
  }

  get exitError(): Error | null {
    return this._exitError;
  }

  constructor(options: TransportOptions) {
    this.options = options;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.initialize();
  }

  /** Wait for the connection to be ready */
  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  private initialize() {
    try {
      const url = new URL(this.options.url);
      if (!url.protocol.startsWith("ws")) {
        throw new Error("WebSocket URL must use ws:// or wss:// protocol");
      }

      this.ws = new WebSocket(url.toString(), {
        headers: this.options.headers,
      });
      this._state = "connecting";

      const timeout = setTimeout(() => {
        if (this._state === "connecting") {
          this.ws?.close();
          const err = new Error("WebSocket connection timeout after 5000ms");
          this._exitError = err;
          this._state = "error";
          this.readyReject?.(err);
        }
      }, 5000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this._state = "connected";
        this.readyResolve?.();

        // Send auth message if provided
        if (this.options.authMessage && this.ws) {
          try {
            this.ws.send(JSON.stringify(this.options.authMessage) + "\n");
          } catch { /* ignore */ }
        }

        // Start keep-alive interval (50 seconds)
        this.keepAliveTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              const keepAlive: WsKeepAlive = { type: "keep_alive" };
              this.ws.send(JSON.stringify(keepAlive) + "\n");
            } catch { /* ignore */ }
          }
        }, 50_000);
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        this._state = "error";
        this._exitError = err;
        this.readyReject?.(err);
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        this._state = "disconnected";
        this.closed = true;
        if (this.keepAliveTimer) {
          clearInterval(this.keepAliveTimer);
          this.keepAliveTimer = null;
        }
        if (code !== 1000 && code !== 1001) {
          this._exitError = new Error(
            `WebSocket closed abnormally with code ${code}: ${reason.toString()}`
          );
        }
        // Resolve any pending message reader
        if (this.messageResolve) {
          this.messageResolve({ done: true, value: undefined as any });
          this.messageResolve = null;
        }
      });

      this.ws.on("message", (data: Buffer | string, isBinary: boolean) => {
        const raw = typeof data === "string" ? data : data.toString("utf-8");
        const lines = raw.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as WsServerMessage;
            this.enqueueMessage(msg);
          } catch { /* skip malformed */ }
        }
      });

      // Handle abort signal
      if (this.options.signal) {
        this.abortHandler = () => {
          this.close();
          this._exitError = new Error("WebSocket connection aborted by user");
        };
        if (this.options.signal.aborted) {
          this.abortHandler();
        } else {
          this.options.signal.addEventListener("abort", this.abortHandler);
        }
      }
    } catch (e) {
      this._state = "error";
      throw e;
    }
  }

  private enqueueMessage(msg: WsServerMessage) {
    if (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = null;
      resolve({ done: false, value: msg });
    } else {
      this.messageQueue.push(msg);
    }
  }

  /** Write a message to the WebSocket */
  write(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /** Signal end of input (no-op for WS, but matches SDK interface) */
  endInput(): void {
    // no-op
  }

  /** Async iterator over incoming messages */
  async *readMessages(): AsyncGenerator<WsServerMessage> {
    while (!this.closed || this.messageQueue.length > 0) {
      if (this.messageQueue.length > 0) {
        yield this.messageQueue.shift()!;
        continue;
      }
      if (this.closed) break;

      const msg = await new Promise<IteratorResult<WsServerMessage>>(
        (resolve) => {
          if (this.messageQueue.length > 0) {
            resolve({ done: false, value: this.messageQueue.shift()! });
          } else if (this.closed) {
            resolve({ done: true, value: undefined as any });
          } else {
            this.messageResolve = resolve;
          }
        }
      );

      if (msg.done) break;
      yield msg.value;
    }
  }

  /** Close the connection */
  close(): void {
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.abortHandler && this.options.signal) {
      this.options.signal.removeEventListener("abort", this.abortHandler);
    }
    this.closed = true;
    this._state = "disconnected";
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
