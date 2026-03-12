/**
 * Example: Connect to a Claude Code Remote session and interact with it.
 *
 * Usage:
 *   CLAUDE_COOKIE="sessionKey=sk-ant-..."  *   CLAUDE_ORG_UUID="ed81b697-..."  *   CLAUDE_SESSION_ID="session_01..."  *   npx tsx examples/basic.ts
 */

import { SessionManager, ClaudeApi } from "../src/index";

const cookie = process.env.CLAUDE_COOKIE\!;
const orgUuid = process.env.CLAUDE_ORG_UUID\!;
const sessionId = process.env.CLAUDE_SESSION_ID;

if (\!cookie || \!orgUuid) {
  console.error("Set CLAUDE_COOKIE and CLAUDE_ORG_UUID environment variables");
  process.exit(1);
}

async function main() {
  const api = new ClaudeApi({ organizationUuid: orgUuid, cookie });

  console.log("--- Listing sessions ---");
  const sessions = await api.listSessions();
  console.log("Found " + sessions.data.length + " sessions");

  const targetSessionId =
    sessionId ??
    sessions.data.find((s) => s.session_status === "active")?.id ??
    sessions.data[0]?.id;

  if (\!targetSessionId) { console.log("No sessions found."); return; }

  console.log("Connecting to session: " + targetSessionId);

  const session = new SessionManager({
    organizationUuid: orgUuid,
    cookie,
    sessionId: targetSessionId,
    replay: true,
    onStateChange(state) { console.log("[state] " + state); },
    onAssistantMessage(msg) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) process.stdout.write(block.text);
      }
    },
    onResult(msg) {
      console.log("\n[result] " + msg.num_turns + " turns, $" + msg.total_cost_usd.toFixed(4));
    },
    onToolPermission: async (toolName, input) => {
      console.log("[tool-permission] " + toolName);
      return { behavior: "allow", updatedInput: input };
    },
    onError(err) { console.error("[error]", err.message); },
  });

  await session.connect();
  console.log("Connected\! Sending message...");
  await session.sendMessage("Hello\! Please respond with a short greeting.");
  await new Promise((resolve) => setTimeout(resolve, 30000));
  session.disconnect();
}

main().catch(console.error);
