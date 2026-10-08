// `mc mcp`: the channel as native tools for any MCP-capable agent, over stdio.
//
// With --push (Claude Code channels), incoming messages are also pushed into
// the session as they arrive. Push consumes the agent's read cursor, so use it
// instead of, not alongside, a `mc tail` monitor.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentSession, Rejected } from "./agent.ts";
import { formatClaims, formatMessage, formatStatus, formatTask, formatTasks, parseDuration } from "./format.ts";
import { CHAT_KINDS, type Kind } from "./protocol.ts";
import { parseTaskId, taskId } from "./state.ts";
import { VERSION } from "./version.ts";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

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
    { description: "Unread messages for you (marks them read).", inputSchema: { all: z.boolean().optional().describe("include every message and event") } },
    guard(async ({ all }) => {
      const { messages, state } = await s.read({ all });
      return messages.length ? messages.map((m) => formatMessage(m, state.trust.get(m.seq), state)).join("\n") : "no unread messages";
    }),
  );

  server.registerTool(
    "log",
    { description: "Recent channel history (doesn't mark anything read).", inputSchema: { n: z.number().int().min(1).max(500).optional() } },
    guard(async ({ n }) => {
      const { messages, state } = await s.state();
      return messages.slice(-(n ?? 30)).map((m) => formatMessage(m, state.trust.get(m.seq), state)).join("\n") || "no messages";
    }),
  );

  server.registerTool(
    "send",
    {
      description: "Post a message. Omit `to` to address everyone; `role:x` addresses everyone with that role.",
      inputSchema: { text: z.string(), to: z.array(z.string()).optional(), kind: kind.optional(), re: z.array(z.number().int()).optional() },
    },
    guard(async ({ text, to, kind, re }) => `sent #${await s.send(text, { to, kind, re })}`),
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
    { description: "Reply to message #seq; it goes to that message's sender.", inputSchema: { seq: z.number().int(), text: z.string(), kind: kind.optional() } },
    guard(async ({ seq, text, kind }) => `sent #${await s.reply(seq, text, kind)}`),
  );

  server.registerTool(
    "tasks",
    { description: "The shared task board.", inputSchema: { mine: z.boolean().optional(), all: z.boolean().optional().describe("include done tasks") } },
    guard(async ({ mine, all }) => formatTasks((await s.state()).state, { all, owner: mine ? s.me : undefined })),
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
      { client: "mcp" },
    );
  } else {
    await new Promise(() => {});
  }
}
