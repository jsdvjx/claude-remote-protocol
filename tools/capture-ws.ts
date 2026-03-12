/**
 * Capture WebSocket traffic from Chrome via CDP (port 19222).
 *
 * Usage: bun run src/capture-ws.ts
 *
 * Prerequisites: Chrome running with --remote-debugging-port=19222
 */

import { writeFileSync } from "fs";

const CDP_PORT = 19222;
const OUTPUT_FILE = "ws-capture.json";
const TARGET_SESSION = process.argv[2] || "YOUR_SESSION_ID";
const TARGET_URL = `https://claude.ai/code/${TARGET_SESSION}`;

interface WsFrame {
  dir: "sent" | "recv";
  requestId: string;
  url?: string;
  data: string;
  timestamp: number;
  opcode?: number;
}

interface HttpReq {
  url: string;
  method: string;
  postData?: string;
  headers: Record<string, string>;
  timestamp: number;
}

const wsConnections: Record<string, string> = {}; // requestId -> url
const wsFrames: WsFrame[] = [];
const httpReqs: HttpReq[] = [];

async function main() {
  // Get list of targets
  const resp = await fetch(`http://localhost:${CDP_PORT}/json`);
  const targets = await resp.json() as any[];

  // Find any claude.ai page
  const target = targets.find((t: any) =>
    t.url?.includes("claude.ai") && t.type === "page"
  );

  if (!target) {
    console.log("Available targets:");
    for (const t of targets) {
      console.log(`  [${t.type}] ${t.url}`);
    }
    console.error("No claude.ai page found!");
    process.exit(1);
  }

  console.log(`Connecting to: ${target.url}`);
  console.log(`WS debug URL: ${target.webSocketDebuggerUrl}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 1;

  function send(method: string, params?: any): Promise<any> {
    return new Promise((resolve) => {
      const id = msgId++;
      const handler = (evt: MessageEvent) => {
        const msg = JSON.parse(evt.data);
        if (msg.id === id) {
          ws.removeEventListener("message", handler);
          resolve(msg.result);
        }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  ws.addEventListener("open", async () => {
    console.log("CDP connected!");

    // Enable Network domain
    await send("Network.enable");
    console.log("Network monitoring enabled.");

    // Also enable Page domain for navigation events
    await send("Page.enable");
    console.log("Page monitoring enabled.");

    // Navigate to the target session so we catch the WS connection from scratch
    console.log(`Navigating to: ${TARGET_URL}`);
    await send("Page.navigate", { url: TARGET_URL });

    console.log("\nListening for WebSocket frames and HTTP /v1/ requests...");
    console.log("Press Ctrl+C to stop and save.\n");

    // Auto-save every 30 seconds
    setInterval(() => {
      saveCapture();
      console.log(`[auto-save] ${wsFrames.length} WS frames, ${httpReqs.length} HTTP requests`);
    }, 30000);
  });

  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);

    switch (msg.method) {
      case "Network.webSocketCreated": {
        const { requestId, url } = msg.params;
        wsConnections[requestId] = url;
        console.log(`[WS-CREATE] ${requestId} → ${url}`);
        break;
      }

      case "Network.webSocketWillSendHandshakeRequest": {
        const { requestId, request } = msg.params;
        console.log(`[WS-HANDSHAKE] ${requestId} headers:`, JSON.stringify(request?.headers || {}).substring(0, 200));
        break;
      }

      case "Network.webSocketHandshakeResponseReceived": {
        const { requestId, response } = msg.params;
        console.log(`[WS-HANDSHAKE-RESP] ${requestId} status:${response?.status} headers:`, JSON.stringify(response?.headers || {}).substring(0, 200));
        break;
      }

      case "Network.webSocketFrameSent": {
        const { requestId, response, timestamp } = msg.params;
        const url = wsConnections[requestId];
        const data = response.payloadData;

        wsFrames.push({ dir: "sent", requestId, url, data, timestamp });

        // Only log Claude-related frames (skip Intercom)
        if (!url?.includes("intercom")) {
          console.log(`[WS-SENT] ${url?.substring(0, 80) || requestId}`);
          // Print each line of the data (newline-delimited JSON)
          for (const line of data.split("\n").filter(Boolean)) {
            try {
              const parsed = JSON.parse(line);
              console.log(`  →`, JSON.stringify(parsed).substring(0, 300));
            } catch {
              console.log(`  → (raw) ${line.substring(0, 300)}`);
            }
          }
        }
        break;
      }

      case "Network.webSocketFrameReceived": {
        const { requestId, response, timestamp } = msg.params;
        const url = wsConnections[requestId];
        const data = response.payloadData;

        wsFrames.push({ dir: "recv", requestId, url, data, timestamp });

        if (!url?.includes("intercom")) {
          console.log(`[WS-RECV] ${url?.substring(0, 80) || requestId}`);
          for (const line of data.split("\n").filter(Boolean)) {
            try {
              const parsed = JSON.parse(line);
              console.log(`  ←`, JSON.stringify(parsed).substring(0, 2000));
            } catch {
              console.log(`  ← (raw) ${line.substring(0, 2000)}`);
            }
          }
        }
        break;
      }

      case "Network.webSocketClosed": {
        const { requestId, timestamp } = msg.params;
        const url = wsConnections[requestId];
        console.log(`[WS-CLOSE] ${url || requestId}`);
        break;
      }

      case "Network.requestWillBeSent": {
        const { request, timestamp } = msg.params;
        // Only track claude.ai /v1/ API calls (skip assets-proxy, analytics)
        if (request.url.includes("/v1/") && request.url.includes("claude.ai/v1/")) {
          httpReqs.push({
            url: request.url,
            method: request.method,
            postData: request.postData,
            headers: request.headers,
            timestamp,
          });
          console.log(`[HTTP] ${request.method} ${request.url.substring(0, 120)}`);
          if (request.postData) {
            console.log(`  body: ${request.postData.substring(0, 1000)}`);
          }
        }
        break;
      }

      case "Network.responseReceived": {
        const { requestId, response } = msg.params;
        if (response.url.includes("claude.ai/v1/")) {
          console.log(`[HTTP-RESP] ${response.status} ${response.url.substring(0, 120)}`);
        }
        break;
      }
    }
  });

  ws.addEventListener("close", () => {
    console.log("CDP disconnected.");
    saveCapture();
  });

  ws.addEventListener("error", (err) => {
    console.error("CDP error:", err);
  });

  // Save on Ctrl+C
  process.on("SIGINT", () => {
    console.log("\n\nSaving capture...");
    saveCapture();
    process.exit(0);
  });
}

function saveCapture() {
  const data = {
    capturedAt: new Date().toISOString(),
    wsConnections,
    wsFrames,
    httpReqs,
  };
  writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(`Saved ${wsFrames.length} WS frames and ${httpReqs.length} HTTP requests to ${OUTPUT_FILE}`);
}

main().catch(console.error);
