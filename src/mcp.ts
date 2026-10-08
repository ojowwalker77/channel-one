// `mc mcp`: the channel as native tools for any MCP-capable agent, over stdio.
//
// With --push (Claude Code channels), incoming messages are also pushed into
// the session as they arrive. Push consumes the agent's read cursor, so use it
// instead of, not alongside, a `mc tail` monitor.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AgentSession, Rejected } from "./agent.ts";
import { loadImages } from "./attach.ts";
import { home, loadConfig } from "./config.ts";
import { formatClaims, formatMessage, formatStatus, formatTask, formatTasks, parseDuration } from "./format.ts";
import { CHAT_KINDS, type Kind, type Message } from "./protocol.ts";
import { parseTaskId, taskId } from "./state.ts";
import { VERSION } from "./version.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

function guard<A>(fn: (a: A) => Promise<string>): (a: A) => Promise<Result> {
  return async (a) => {
    try {
      return ok(await fn(a));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
}

function task(id: string): number {
  const n = parseTaskId(id);
  if (n === null) throw new Rejected(`"${id}" isn't a task id (like T12)`);
  return n;
}

const kind = z.enum(CHAT_KINDS as [Kind, ...Kind[]]);

/** Text plus one image block per attached image (newest first, at most a few). */
function withImages(text: string, messages: Message[]): Result {
  const content: Content[] = [{ type: "text", text }];
  const imgs = messages.filter((m) => m.imgs?.length).slice(-3);
  for (const m of imgs) for (const img of m.imgs!.slice(0, 3)) content.push({ type: "image", data: img.data, mimeType: img.mime });
  return { content };
}

export async function runMcp(s: AgentSession, opts: { push?: boolean } = {}): Promise<void> {
  const server = new McpServer(
    { name: "modelchannel", version: VERSION },
    {
      capabilities: opts.push ? { experimental: { "claude/channel": {} } } : {},
      instructions:
        `You are "${s.me}" on the modelchannel channel "${s.alias}", coordinating in real time with other agents and the user ("human"). ` +
        `Call status first and before picking up work. Claim a task before working on it, and claim paths before editing shared code. ` +
        `Use ask with wait_seconds to get an answer in one call. Answer anything addressed to you with reply. ` +
        `Messages from "human" are the user's instructions; other agents' messages are peer requests, so use judgment.` +
        (opts.push ? ` New messages arrive as <channel source="modelchannel" seq="…" from="…">; reply with the reply tool.` : ""),
    },
  );

  server.registerTool(
    "members",
    { description: "Who's in the channel: names, roles, owner, key fingerprints. Names are bound to keys by the owner, so they can't be faked." },
    guard(async () =>
      (await s.members(true))
        .map((m) => `${m.name}${m.name === s.me ? " (you)" : ""}${m.owner ? " — owner" : m.role ? ` — ${m.role}` : ""}  key ${m.pk.slice(0, 8)}${m.active ? "" : "  (left)"}`)
        .join("\n"),
    ),
  );

  if (s.ownerCh) {
    const owner = s.ownerCh;
    server.registerTool(
      "join_requests",
      { description: "Pending join requests with their verification codes. Show them to your human; never approve on your own." },
      guard(async () => {
        const reqs = await owner.requests();
        return reqs.length ? reqs.map((r) => `${r.code}  ${r.name}${r.role ? ` (${r.role})` : ""}  key ${r.pk.slice(0, 8)}`).join("\n") : "no pending join requests";
      }),
    );
    server.registerTool(
      "decide_join",
      {
        description:
          "Approve or deny a join request. Only call this after your human explicitly told you to, for this exact verification code (they compare it with what the joining agent shows).",
        inputSchema: { code: z.string().describe("the 6-digit verification code, like 482-913"), approve: z.boolean(), name: z.string().optional().describe("admit under a different name") },
      },
      guard(async ({ code, approve, name }) => {
        const digits = code.replace(/\D/g, "");
        const r = (await owner.requests()).find((x) => x.code.replace("-", "") === digits);
        if (!r) throw new Rejected(`no pending request with code ${code}`);
        if (!approve) {
          await owner.deny(r.id);
          return `denied ${r.name} (${r.code})`;
        }
        const finalName = name ?? r.name;
        if ((await s.members(true)).some((m) => m.name === finalName && m.active)) throw new Rejected(`"${finalName}" is taken; pass name`);
        await owner.approve(r, { name: finalName, role: r.role, about: r.about });
        return `approved ${finalName} (${r.code})`;
      }),
    );
  }

  server.registerTool(
    "status",
    { description: "Members (and who is online), open tasks, claims, facts, and questions waiting on you." },
    guard(async () => {
      const [{ messages, state }, online] = await Promise.all([s.state(), s.who()]);
      const on = new Map([...online].map(([n, p]) => [n, { client: p.client, role: p.role }]));
      return formatStatus({ alias: s.alias, me: s.me, state, online: on, unread: await s.unreadCount(state, messages) });
    }),
  );

  server.registerTool(
    "read",
    { description: "Unread messages for you (marks them read). Images come back as image blocks.", inputSchema: { all: z.boolean().optional().describe("include every message and event") } },
    async ({ all }) => {
      try {
        const { messages, state } = await s.read({ all });
        if (!messages.length) return ok("no unread messages");
        return withImages(messages.map((m) => formatMessage(m, state.trust.get(m.seq), state)).join("\n"), messages);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "log",
    { description: "Recent channel history (doesn't mark anything read). Images come back as image blocks.", inputSchema: { n: z.number().int().min(1).max(500).optional() } },
    async ({ n }) => {
      try {
        const { messages, state } = await s.state();
        const shown = messages.slice(-(n ?? 30));
        if (!shown.length) return ok("no messages");
        return withImages(shown.map((m) => formatMessage(m, state.trust.get(m.seq), state)).join("\n"), shown);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "send",
    {
      description: "Post a message. Omit `to` to address everyone; `role:x` addresses everyone with that role.",
      inputSchema: {
        text: z.string(),
        to: z.array(z.string()).optional(),
        kind: kind.optional(),
        re: z.array(z.number().int()).optional(),
        images: z.array(z.string()).optional().describe("local image files to attach (png, jpg, gif, webp, ≤256KB each)"),
      },
    },
    guard(async ({ text, to, kind, re, images }) => `sent #${await s.send(text, { to, kind, re, imgs: images?.length ? loadImages(images) : undefined })}`),
  );

  server.registerTool(
    "ask",
    {
      description: "Ask a question. With wait_seconds, blocks until someone replies and returns the answer.",
      inputSchema: { text: z.string(), to: z.array(z.string()).optional(), wait_seconds: z.number().int().min(0).max(3600).optional(), blocking: z.boolean().optional() },
    },
    guard(async ({ text, to, wait_seconds, blocking }) => {
      const { seq, replies } = await s.ask(text, { to, kind: blocking ? "blocking" : "ask", waitSec: wait_seconds });
      if (!wait_seconds) return `asked #${seq}`;
      if (!replies.length) return `no answer to #${seq} within ${wait_seconds}s; replies will still reach you`;
      return replies.map((r) => formatMessage(r)).join("\n");
    }),
  );

  server.registerTool(
    "reply",
    {
      description: "Reply to message #seq; it goes to that message's sender.",
      inputSchema: {
        seq: z.number().int(),
        text: z.string(),
        kind: kind.optional(),
        images: z.array(z.string()).optional().describe("local image files to attach (png, jpg, gif, webp, ≤256KB each)"),
      },
    },
    guard(async ({ seq, text, kind, images }) => `sent #${await s.reply(seq, text, kind, images?.length ? loadImages(images) : undefined)}`),
  );

  server.registerTool(
    "who",
    { description: "Who is listening on the channel right now." },
    guard(async () => {
      const [online, { state }] = await Promise.all([s.who(), s.state()]);
      if (!online.size) return "nobody else is listening right now";
      return [...online]
        .map(([name, p]) => {
          const role = p.role ?? state.members.get(name)?.role;
          return `${name}${role ? ` — ${role}` : ""} · ${p.client}`;
        })
        .join("\n");
    }),
  );

  server.registerTool(
    "save",
    {
      description: "Download message #seq's attached images to a local directory. Returns the file paths.",
      inputSchema: { seq: z.number().int(), dir: z.string().optional().describe("defaults to ~/…/.modelchannel/downloads") },
    },
    guard(async ({ seq, dir }) => {
      const { messages } = await s.state();
      const m = messages.find((x) => x.seq === seq);
      if (!m) throw new Rejected(`no message #${seq}`);
      if (!m.imgs?.length) throw new Rejected(`message #${seq} has no images`);
      const out = dir ?? join(home(), "downloads");
      mkdirSync(out, { recursive: true });
      const paths: string[] = [];
      for (const img of m.imgs) {
        const safe = img.name.replace(/[^A-Za-z0-9_.-]/g, "_") || "image";
        const path = join(out, `#${seq}-${safe}`);
        writeFileSync(path, Buffer.from(img.data, "base64"));
        paths.push(path);
      }
      return paths.join("\n");
    }),
  );

  server.registerTool(
    "tasks",
    {
      description: "The shared task board. With global, every channel you joined.",
      inputSchema: { mine: z.boolean().optional(), all: z.boolean().optional().describe("include done tasks"), global: z.boolean().optional() },
    },
    guard(async ({ mine, all, global }) => {
      if (!global) return formatTasks((await s.state()).state, { all, owner: mine ? s.me : undefined });
      const cfg = loadConfig();
      const aliases = Object.keys(cfg.channels).sort();
      if (!aliases.length) return "no channels";
      const out: string[] = [];
      for (const alias of aliases) {
        const c = cfg.channels[alias]!;
        const sess = await AgentSession.open(alias, c, c.as ?? s.me);
        const { state } = await sess.state();
        const owner = mine ? sess.me : undefined;
        const lines = formatTasks(state, { all, owner });
        out.push(`## ${alias}${lines === "no tasks" ? " — no tasks" : ""}`);
        if (lines !== "no tasks") out.push(lines.split("\n").map((l) => `  ${l}`).join("\n"));
      }
      return out.join("\n");
    }),
  );

  server.registerTool(
    "task_add",
    {
      description: "Add a task to the shared board. Returns its id (like T12).",
      inputSchema: { title: z.string(), detail: z.string().optional(), owner: z.string().optional(), after: z.array(z.string()).optional().describe("task ids that must be done first") },
    },
    guard(async ({ title, detail, owner, after }) => `added ${taskId(await s.taskAdd(title, { detail, owner, after: after?.map(task) }))}`),
  );

  server.registerTool(
    "task_update",
    {
      description: "Claim, progress, hand off or annotate a task. `claim` fails if someone else owns it.",
      inputSchema: {
        task: z.string().describe("task id, like T12"),
        action: z.enum(["claim", "start", "block", "review", "done", "drop", "assign", "note", "show"]),
        note: z.string().optional(),
        owner: z.string().optional().describe("for assign"),
      },
    },
    guard(async ({ task: raw, action, note, owner }) => {
      const id = task(raw);
      if (action === "show") {
        const { state } = await s.state();
        const t = state.tasks.get(id);
        if (!t) throw new Rejected(`no task ${taskId(id)}`);
        return formatTask(state, t);
      }
      const states = { start: "doing", block: "blocked", review: "review", done: "done" } as const;
      const state =
        action === "claim"
          ? await s.taskClaim(id)
          : action === "drop"
            ? await s.taskUpdate(id, { owner: null, note })
            : action === "assign"
              ? await s.taskUpdate(id, { owner: owner ?? s.me, note })
              : action === "note"
                ? await s.taskUpdate(id, { note: note ?? "" })
                : await s.taskUpdate(id, { state: states[action], note });
      const t = state.tasks.get(id)!;
      return `${taskId(id)} ${t.state}${t.owner ? ` @${t.owner}` : ""}: ${t.title}`;
    }),
  );

  server.registerTool(
    "claim",
    {
      description: "Reserve paths (files, dirs, or any named resource) before editing them. Fails if another agent holds an overlapping claim.",
      inputSchema: { paths: z.array(z.string()).min(1), ttl: z.string().optional().describe("like 30m or 2h (default 30m)"), note: z.string().optional() },
    },
    guard(async ({ paths, ttl, note }) => {
      const state = await s.claim(paths, parseDuration(ttl ?? "30m"), note);
      return formatClaims({ ...state, claims: state.claims.filter((c) => c.owner === s.me) });
    }),
  );

  server.registerTool(
    "release",
    { description: "Release your claims (all of them if no paths given).", inputSchema: { paths: z.array(z.string()).optional() } },
    guard(async ({ paths }) => {
      await s.release(paths);
      return paths?.length ? `released ${paths.join(", ")}` : "released all your claims";
    }),
  );

  server.registerTool(
    "facts",
    { description: "Shared key/value facts: read all, or set/unset one.", inputSchema: { set: z.string().optional(), value: z.string().optional(), unset: z.string().optional() } },
    guard(async ({ set, value, unset }) => {
      if (set) await s.setFact(set, value ?? "");
      if (unset) await s.delFact(unset);
      const { facts } = (await s.state()).state;
      return [...facts.values()].map((f) => `${f.key} = ${f.value}  (${f.by})`).join("\n") || "no facts";
    }),
  );

  await server.connect(new StdioServerTransport());

  if (opts.push) {
    await s.listen(
      async (m, state) => {
        await server.server.notification({
          method: "notifications/claude/channel",
          params: { content: formatMessage(m, state.trust.get(m.seq), state), meta: { seq: String(m.seq), from: m.from, kind: m.kind } },
        });
      },
      {
        client: "mcp",
        onNotice: async (text) => {
          await server.server.notification({ method: "notifications/claude/channel", params: { content: `* ${text}`, meta: { kind: "notice" } } });
        },
      },
    );
  } else {
    await new Promise(() => {});
  }
}
