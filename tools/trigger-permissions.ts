/**
 * Trigger tool permission flows via CDP by sending messages in the Claude Code session.
 *
 * This script:
 * 1. Connects to Chrome CDP
 * 2. Finds the claude.ai session page
 * 3. Types messages that will trigger tool permission prompts
 * 4. Monitors the resulting WS traffic
 *
 * Usage: bun run src/trigger-permissions.ts
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

  ws.addEventListener("open", async () => {
    console.log("CDP connected!");

    // Enable Runtime for JS evaluation
    await send("Runtime.enable");
    console.log("Runtime enabled.");

    // Step 1: Find the input textarea and type a message that will trigger tool use with permission
    // The Claude Code web UI uses a textarea for input

    // First, let's check what's on the page
    const pageInfo = await send("Runtime.evaluate", {
      expression: `document.querySelector('textarea, [contenteditable], input[type="text"], [role="textbox"]')?.tagName + '|' + document.querySelector('textarea, [contenteditable], input[type="text"], [role="textbox"]')?.className`,
      returnByValue: true
    });
    console.log("Input element:", pageInfo?.result?.value);

    // Try to find and focus the input
    const focusResult = await send("Runtime.evaluate", {
      expression: `
        // Try multiple selectors for the input
        const selectors = [
          'textarea',
          '[contenteditable="true"]',
          'input[type="text"]',
          '[role="textbox"]',
          '.ProseMirror',
          '[data-placeholder]'
        ];
        let el = null;
        for (const sel of selectors) {
          el = document.querySelector(sel);
          if (el) break;
        }
        if (el) {
          el.focus();
          'found: ' + el.tagName + '.' + el.className;
        } else {
          'not found - all elements: ' + Array.from(document.querySelectorAll('*')).filter(e => e.tagName === 'TEXTAREA' || e.contentEditable === 'true' || e.tagName === 'INPUT').map(e => e.tagName + '.' + e.className).join(', ');
        }
      `,
      returnByValue: true
    });
    console.log("Focus result:", focusResult?.result?.value);

    // Message that will trigger a Write tool (needs permission)
    // and also trigger Bash (needs permission)
    const testMessage = "请创建一个文件 /tmp/test-permission.txt 写入 hello world，然后用 bash 执行 echo done";

    // Type the message using Input.insertText (works with any focused element)
    await send("Input.insertText", { text: testMessage });
    console.log(`Typed message: "${testMessage}"`);

    // Wait a moment then press Enter to submit
    await new Promise(r => setTimeout(r, 500));

    // Press Enter (or Ctrl+Enter depending on the UI)
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
    console.log("Pressed Enter to submit.");

    // Now monitor WS frames for permission requests
    console.log("\nMonitoring for permission requests (can_use_tool)...");
    console.log("The capture-ws.ts script should be recording everything.");
    console.log("Press Ctrl+C when done.\n");
  });

  // Also monitor WS frames from this CDP connection
  ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.method === "Network.webSocketFrameReceived" || msg.method === "Network.webSocketFrameSent") {
      const { requestId, response } = msg.params;
      const data = response?.payloadData;
      if (data && !data.includes("intercom")) {
        // Look for can_use_tool, control_request, control_response
        if (data.includes("can_use_tool") || data.includes("control_request") || data.includes("permission")) {
          const dir = msg.method.includes("Sent") ? "→" : "←";
          console.log(`\n[PERMISSION-RELATED] ${dir}`);
          for (const line of data.split("\n").filter(Boolean)) {
            try {
              console.log(JSON.stringify(JSON.parse(line), null, 2));
            } catch {
              console.log(line);
            }
          }
        }
      }
    }
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
