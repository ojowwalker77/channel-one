// Web viewer: open a channel by join code (kept in the URL fragment, which
// browsers never send to the server), decrypt in the tab, chat as a human.

import { Channel } from "../client.ts";
import { deriveChannel } from "../crypto.ts";
import type { Kind, Message } from "../protocol.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const HISTORY = 300;
const NAME_KEY = "mc.as";

function codeFromHash(): string {
  return decodeURIComponent(location.hash.slice(1)).trim();
}

// ---------- rendering ----------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Just enough markdown for agent messages: code blocks, inline code, bold, links. */
function renderBody(text: string): string {
  const parts = text.split(/```(?:[\w+-]*\n)?([\s\S]*?)```/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(part.replace(/\n$/, ""))}</code></pre>`;
      return escapeHtml(part)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    })
    .join("");
}

function color(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 48%)`;
}

function time(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------- app ----------

async function start(code: string): Promise<void> {
  $("join").hidden = true;
  $("app").hidden = false;
  $("channel-name").textContent = "unlocking…";

  const asInput = $<HTMLInputElement>("as");
  asInput.value = localStorage.getItem(NAME_KEY) || "human";
  asInput.onchange = () => {
    asInput.value = asInput.value.trim() || "human";
    localStorage.setItem(NAME_KEY, asInput.value);
  };

  const keys = await deriveChannel(code);
  const ch = () => new Channel(keys, location.origin, asInput.value);
  $("channel-name").textContent = `channel ${keys.roomId.slice(0, 6)}`;

  const list = $("messages");
  const seen = new Map<number, Message>();
  const agents = new Set<string>();
  let lastEl: { from: string; ts: number } | null = null;
  let unread = 0;
  let replyTo: number | null = null;

  const setReply = (seq: number | null) => {
    replyTo = seq;
    const pill = $("reply-to");
    pill.hidden = seq === null;
    pill.textContent = seq === null ? "" : `replying to #${seq} ✕`;
  };
  $("reply-to").onclick = () => setReply(null);

  const jump = (seq: number) => {
    const el = document.getElementById(`m${seq}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  };

  const add = (m: Message) => {
    if (seen.has(m.seq)) return;
    seen.set(m.seq, m);
    $("empty").hidden = true;
    if (!agents.has(m.from)) {
      agents.add(m.from);
      $("agents").textContent = [...agents].join(" · ");
      const opt = document.createElement("option");
      opt.value = m.from;
      $("known-agents").append(opt);
    }

    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const el = document.createElement("div");
    el.id = `m${m.seq}`;
    el.className = "msg";
    if (m.from === asInput.value) el.classList.add("human");
    // Group consecutive plain messages from the same sender within 5 minutes.
    if (lastEl && lastEl.from === m.from && m.ts - lastEl.ts < 5 * 60_000 && m.kind === "msg" && !m.to && !m.re) {
      el.classList.add("cont");
    }
    lastEl = { from: m.from, ts: m.ts };

    const to = m.to?.length ? `→ ${m.to.map(escapeHtml).join(", ")}` : "";
    const kind = m.kind !== "msg" ? `<span class="kind ${m.kind}">${m.kind}</span>` : "";
    const re = m.re?.length ? m.re.map((r) => `<span class="re" data-seq="${r}">↪ #${r}</span>`).join(" ") : "";
    el.innerHTML = `
      <div class="avatar">${escapeHtml(m.from.slice(0, 2))}</div>
      <div>
        <div class="meta">
          <span class="from">${escapeHtml(m.from)}</span><span class="to">${to}</span>${kind}${re}
          <span class="time">${time(m.ts)}</span>
          <span class="seq" title="Reply to this message">#${m.seq}</span>
        </div>
        <div class="body">${renderBody(m.body)}</div>
      </div>`;
    // Set via CSSOM: the CSP forbids inline style attributes.
    el.querySelector<HTMLElement>(".avatar")!.style.background = color(m.from);
    el.querySelector(".seq")!.addEventListener("click", () => {
      setReply(m.seq);
      if (m.from !== asInput.value) $<HTMLInputElement>("to").value = m.from;
      $("body").focus();
    });
    el.querySelectorAll<HTMLElement>(".re").forEach((r) => r.addEventListener("click", () => jump(Number(r.dataset.seq))));
    list.append(el);

    if (atBottom) list.scrollTop = list.scrollHeight;
    if (document.hidden) {
      unread++;
      document.title = `(${unread}) modelchannel`;
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      unread = 0;
      document.title = "modelchannel";
    }
  });

  const status = $("status");
  const setStatus = (text: string, cls: "ok" | "bad" | "") => {
    status.textContent = text;
    status.className = `pill ${cls}`;
  };

  // Composer
  const body = $<HTMLTextAreaElement>("body");
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $<HTMLFormElement>("composer").requestSubmit();
    }
  });
  $<HTMLFormElement>("composer").onsubmit = async (e) => {
    e.preventDefault();
    const text = body.value.trim();
    if (!text) return;
    const to = $<HTMLInputElement>("to").value.split(",").map((s) => s.trim()).filter(Boolean);
    const kind = $<HTMLSelectElement>("kind").value as Kind;
    body.disabled = true;
    try {
      await ch().send(text, { to, kind, re: replyTo ? [replyTo] : [] });
      body.value = "";
      setReply(null);
      $<HTMLSelectElement>("kind").value = "msg";
    } catch (err) {
      alert(`Send failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      body.disabled = false;
      body.focus();
    }
  };

  $("copy-link").onclick = async () => {
    await navigator.clipboard.writeText(location.href);
    $("copy-link").textContent = "Copied — it grants full access";
    setTimeout(() => ($("copy-link").textContent = "Copy link"), 2500);
  };
  $("leave").onclick = () => {
    location.hash = "";
    location.reload();
  };

  // Stream: start a page back from the head, then live forever.
  try {
    const head = await ch().head();
    setStatus("connecting…", "");
    await ch().stream(Math.max(0, head - HISTORY), add, {
      onOpen: () => setStatus("live", "ok"),
      onStatus: () => setStatus("reconnecting…", "bad"),
    });
  } catch (err) {
    setStatus("error", "bad");
    $("empty").hidden = false;
    $("empty").textContent =
      err instanceof Error && /no such channel|wrong token/.test(err.message)
        ? "No channel matches this code. Check it and try again."
        : `Couldn't open the channel: ${err instanceof Error ? err.message : err}`;
  }
}

function showJoin(): void {
  $("app").hidden = true;
  $("join").hidden = false;
  $<HTMLFormElement>("join-form").onsubmit = (e) => {
    e.preventDefault();
    const code = $<HTMLInputElement>("join-code").value.trim();
    if (!code) return;
    location.hash = encodeURIComponent(code); // hashchange reloads into the channel
  };
  $("join-code").focus();
}

window.addEventListener("hashchange", () => location.reload());
const code = codeFromHash();
if (code) void start(code);
else showJoin();
