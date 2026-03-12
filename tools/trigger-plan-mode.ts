/**
 * Trigger plan mode selection flows via CDP.
 *
 * 1. Send a message to enter plan mode
 * 2. Send a task that requires planning/selection
 * 3. Monitor the WS traffic for selection-related messages
 *
 * Usage: bun run src/trigger-plan-mode.ts
 */

const CDP_PORT = 19222;

async function main() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json`);
  const targets = await resp.json() as any[];

  const target = targets.find((t: any) =>
    t.url?.includes("claude.ai/code") && t.type === "page"
  );

  if (!target) {
    console.error("No claude.ai/code page found!");
    process.exit(1);
  }

  console.log(`Connecting to: ${target.url}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 1;

  function send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 15000);
      const handler = (evt: MessageEvent) => {
        const msg = JSON.parse(evt.data);
        if (msg.id === id) {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve(msg.result);
        }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function typeAndSubmit(text: string) {
    // Focus the textarea
    await send("Runtime.evaluate", {
      expression: `document.querySelector('textarea')?.focus()`,
      returnByValue: true
    });
    await new Promise(r => setTimeout(r, 200));

    // Clear any existing text
    await send("Runtime.evaluate", {
      expression: `document.querySelector('textarea').value = ''`,
      returnByValue: true
    });

    // Type the message
    await send("Input.insertText", { text });
    console.log(`Typed: "${text}"`);
    await new Promise(r => setTimeout(r, 300));

    // Submit with Enter
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });
    console.log("Submitted.");
  }

  ws.addEventListener("open", async () => {
    console.log("CDP connected!");
    await send("Runtime.enable");
    await send("Network.enable");

    // Monitor all WS frames for interesting messages
    ws.addEventListener("message", (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.method === "Network.webSocketFrameReceived" || msg.method === "Network.webSocketFrameSent") {
        const data = msg.params?.response?.payloadData;
        if (data && !data.includes("intercom")) {
          // Look for plan mode, selection, permission, control messages
          if (data.includes("plan") || data.includes("select") || data.includes("permission") ||
              data.includes("can_use_tool") || data.includes("control_request") ||
              data.includes("AskUser") || data.includes("ExitPlanMode") || data.includes("EnterPlanMode")) {
            const dir = msg.method.includes("Sent") ? "SENT →" : "RECV ←";
            console.log(`\n[${dir}]`);
            for (const line of data.split("\n").filter(Boolean)) {
              try {
                const parsed = JSON.parse(line);
                console.log(JSON.stringify(parsed, null, 2).substring(0, 3000));
              } catch {
                console.log(line.substring(0, 1000));
              }
            }
          }
        }
      }
    });

    // Step 1: Type /plan to enter plan mode
    console.log("\n=== Step 1: Entering plan mode ===");
    await typeAndSubmit("/plan");

    // Wait for plan mode to activate
    await new Promise(r => setTimeout(r, 3000));

    // Step 2: Send a message that requires planning with choices
    console.log("\n=== Step 2: Sending task that needs planning ===");
    await typeAndSubmit("帮我重构 src/session.ts，给我三个不同的方案选择");

    console.log("\nMonitoring for plan mode selection messages...");
    console.log("Press Ctrl+C when done.\n");
  });

  ws.addEventListener("close", () => {
    console.log("CDP disconnected.");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("Done.");
    process.exit(0);
  });
}

main().catch(console.error);
