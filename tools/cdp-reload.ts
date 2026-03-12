/**
 * Reload the Claude session page via CDP to trigger fresh WS connection.
 */

const CDP_PORT = 19222;

async function main() {
  const resp = await fetch(`http://localhost:${CDP_PORT}/json`);
  const targets = await resp.json() as any[];
  const target = targets.find((t: any) => t.url?.includes("claude.ai/code/session_"));

  if (!target) {
    console.error("No session page found");
    process.exit(1);
  }

  console.log(`Found: ${target.url}`);
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
    console.log("Reloading page...");
    await send("Page.reload");
    console.log("Page reload triggered. Waiting 3s...");
    setTimeout(() => {
      ws.close();
      console.log("Done.");
      process.exit(0);
    }, 3000);
  });
}

main().catch(console.error);
