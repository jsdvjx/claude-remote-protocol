import { readFileSync } from "fs";

const data = JSON.parse(readFileSync("ws-capture.json", "utf8"));
const frames = data.wsFrames.filter((f: any) => !(f.url || "").includes("intercom"));

// Check: what fields does 'result' type have that we might miss?
console.log("=== result message full fields ===");
for (const f of frames) {
  for (const line of f.data.split("\n").filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "result") {
        console.log("Keys:", Object.keys(msg).sort().join(", "));
        // Check usage structure
        if (msg.usage) console.log("Usage keys:", Object.keys(msg.usage).sort().join(", "));
      }
    } catch {}
  }
}

// Check: set_permission_mode flow (sent by web client for /plan)
console.log("\n=== set_permission_mode ===");
for (const f of frames) {
  for (const line of f.data.split("\n").filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      if (msg.request?.subtype === "set_permission_mode" ||
          (msg.type === "control_request" && JSON.stringify(msg).includes("permission_mode"))) {
        console.log(f.dir, JSON.stringify(msg, null, 2).substring(0, 500));
      }
    } catch {}
  }
}

// Check: any HTTP POST to events (user messages)
console.log("\n=== HTTP POST events ===");
for (const req of data.httpReqs) {
  if (req.method === "POST" && req.url.includes("/events")) {
    console.log(`${req.method} ${req.url}`);
    if (req.postData) {
      try {
        const body = JSON.parse(req.postData);
        console.log(JSON.stringify(body, null, 2).substring(0, 1000));
      } catch {
        console.log(req.postData.substring(0, 500));
      }
    }
  }
}

// Check: any slash_commands in events
console.log("\n=== Slash commands in events ===");
for (const f of frames) {
  if (f.data.includes("slash_command")) {
    for (const line of f.data.split("\n").filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        if (msg.slash_commands || msg.message?.slash_commands) {
          console.log(f.dir, JSON.stringify(msg, null, 2).substring(0, 500));
        }
      } catch {}
    }
  }
}

// Check: any interrupted messages
console.log("\n=== Interrupted messages ===");
for (const f of frames) {
  if (f.data.includes("interrupt")) {
    for (const line of f.data.split("\n").filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "user" && JSON.stringify(msg.message).includes("interrupt")) {
          console.log(f.dir, "User interrupt:", JSON.stringify(msg.message?.content).substring(0, 200));
        }
        if (msg.request?.subtype === "interrupt") {
          console.log(f.dir, "Control interrupt:", JSON.stringify(msg, null, 2).substring(0, 500));
        }
      } catch {}
    }
  }
}
