import { readFileSync } from "fs";

const data = JSON.parse(readFileSync("ws-capture.json", "utf8"));
const frames = data.wsFrames.filter((f: any) => !(f.url || "").includes("intercom"));

console.log("=== control_cancel_request ===");
for (const f of frames) {
  for (const line of f.data.split("\n").filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "control_cancel_request")
        console.log(f.dir, JSON.stringify(msg, null, 2));
    } catch {}
  }
}

console.log("\n=== result type ===");
for (const f of frames) {
  for (const line of f.data.split("\n").filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "result")
        console.log(f.dir, JSON.stringify(msg, null, 2).substring(0, 500));
    } catch {}
  }
}

console.log("\n=== error responses ===");
for (const f of frames) {
  for (const line of f.data.split("\n").filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.response?.subtype === "error")
        console.log(f.dir, JSON.stringify(msg, null, 2));
    } catch {}
  }
}

console.log("\n=== ExitPlanMode can_use_tool ===");
for (const f of frames) {
  for (const line of f.data.split("\n").filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "control_request" && msg.request?.tool_name === "ExitPlanMode")
        console.log(f.dir, JSON.stringify(msg, null, 2).substring(0, 1500));
      if (msg.message?.content?.[0]?.name === "ExitPlanMode")
        console.log(f.dir, "assistant tool_use:", JSON.stringify(msg.message.content[0], null, 2).substring(0, 500));
    } catch {}
  }
}

console.log("\n=== Streaming: first msg with thinking ===");
let found = false;
for (const f of frames) {
  if (found) break;
  for (const line of f.data.split("\n").filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "assistant" && msg.message?.content?.[0]?.type === "thinking" && !found) {
        found = true;
        // Show full structure but truncate signature
        const copy = JSON.parse(JSON.stringify(msg));
        if (copy.message.content[0].signature) {
          copy.message.content[0].signature = copy.message.content[0].signature.substring(0, 50) + "...";
        }
        console.log(f.dir, JSON.stringify(copy, null, 2));
      }
    } catch {}
  }
}
