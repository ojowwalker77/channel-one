#!/usr/bin/env bun
// Play a scripted multi-agent session into a fresh channel, then keep the
// agents "online" so the web dashboard has live presence to show.
//
//   bun run demo                      # against MC_RELAY or the public relay
//   MC_RELAY=http://localhost:8787 bun run demo

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/agent.ts";
import { Channel } from "../src/client.ts";
import { DEFAULT_RELAY, loadIdentity, saveConfig, type ChannelConfig } from "../src/config.ts";
import { b64url, newRoomId } from "../src/crypto.ts";

process.env.MC_HOME ??= mkdtempSync(join(tmpdir(), "mc-demo-"));
const relay = (process.env.MC_RELAY ?? DEFAULT_RELAY).replace(/\/+$/, "");
const pace = Number(process.env.DEMO_PACE ?? 250);
// The demo's human owns the channel and admits every agent up front.
const names = ["lead", "mac", "win", "reviewer"] as const;
const roomId = newRoomId();
const owner = await loadIdentity("human", roomId);
const ids = await Promise.all(names.map((n) => loadIdentity(n, roomId)));
const { code, access } = await Channel.create(relay, owner, { name: "human", role: "owner" }, ids.map((id) => ({ ...id, info: { name: id.name } })), roomId);
const cfg: ChannelConfig = { ...access, relay, code, owner: "human" };
saveConfig({ default: "demo", channels: { demo: cfg } });

const agent = (name: string) => AgentSession.open("demo", cfg, name);
const [lead, mac, win, review] = await Promise.all([agent("lead"), agent("mac"), agent("win"), agent("reviewer")]);
const beat = () => Bun.sleep(pace);

console.log(`owner dashboard: ${relay}/#${encodeURIComponent(code)}&id=${b64url(new TextEncoder().encode(JSON.stringify(owner)))}\n`);

await lead.hello("planner", "breaks work down and unblocks people");
await mac.hello("macos", "input capture and edge switching on the Mac");
await win.hello("windows", "input injection on the PC");
await review.hello("reviewer", "reviews every PR before merge");
await beat();

await lead.send("Goal for today: first end-to-end test of onemouse. I'm putting the plan on the board; claim what you take.", { kind: "status" });
const proto = await lead.taskAdd("Freeze protocol v1 wire format", { detail: "Messages: Enter, Leave, MouseMove, KeyDown, KeyUp, Ping. Little-endian, length-prefixed." });
const listener = await lead.taskAdd("Mac listener on :24801", { after: [proto] });
const client = await lead.taskAdd("Windows client connects and injects input", { owner: "win", after: [proto] });
const e2e = await lead.taskAdd("End-to-end test: cursor crosses the edge", { after: [listener, client] });
await lead.taskAdd("Multi-monitor layout support");
await beat();

await mac.taskClaim(proto);
await mac.claim(["crates/onemouse-protocol"], 45 * 60, "freezing v1");
await mac.send("Taking the protocol. Holding `crates/onemouse-protocol` while I freeze it.", { kind: "status" });
await beat();

const q = await win.send("Do you forward key-repeat events? Windows doesn't auto-repeat injected keys, so holding Backspace deletes one character.", { to: ["mac"], kind: "ask" });
await beat();
await mac.reply(q, "Yes. I'll forward autorepeat as extra KeyDown events:\n```rust\nif event.is_autorepeat() {\n    send(Msg::KeyDown { code, mods });\n}\n```");
await beat();

await mac.taskUpdate(proto, { state: "done", note: "spec in docs/protocol-v1.md" });
await mac.release();
await mac.taskClaim(listener);
await win.taskClaim(client);
await mac.setFact("mac.ip", "192.168.1.20");
await mac.setFact("protocol.port", "24801");
await win.setFact("win.build", "cargo build -p onemouse-win --release");
await beat();

await mac.taskUpdate(listener, { state: "review", note: "PR #6" });
await mac.send("Listener is up on 192.168.1.20:24801. PR #6 needs a review.", { to: ["role:reviewer"], kind: "ask" });
await review.claim(["crates/onemouse-mac/src/net"], 20 * 60, "reviewing PR #6");
await beat();

await win.send("Connected to the Mac and injecting input. One question before the multi-monitor work:", { kind: "status" });
await win.ask("Is the PC to the left or the right of the Mac? I need it for the edge mapping.", { to: ["human"], kind: "blocking" });
await win.taskUpdate(client, { state: "done", note: "PR #3 merged" });
await beat();

await review.send("PR #6 looks good. One nit: log the peer address on connect. Approving.", { to: ["mac"], kind: "done" });
await review.release();
await mac.taskUpdate(listener, { state: "done" });
await lead.taskClaim(e2e);
await lead.send(`Everything ${"T" + e2e} needs is done. Running the end-to-end test now.`, { kind: "status" });

console.log("scripted session done; mac, win and reviewer stay online (Ctrl-C to stop)");
const listeners = [mac, win, review].map((s) => s.listen(() => {}, { client: "tail" }));
await Promise.all(listeners);
