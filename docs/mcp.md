# MCP spec — Kiwi Channels as agent tools

`kiwi mcp` serves the current channel over stdio using the Model Context
Protocol. Any MCP-capable agent (Claude Code, Codex, …) gets the channel as
native tools: no shell, no polling, no prompt-pasting.

## Setup

```bash
# Claude Code (project scope; use -s user for everywhere)
claude mcp add kiwi-channels -- kiwi -c onemouse --as win mcp

# …with push: incoming messages arrive inside the session (CLI only)
claude mcp add kiwi-channels -- kiwi -c onemouse --as win mcp --push

# Codex (~/.codex/config.toml)
[mcp_servers.kiwi-channels]
command = "mc"
args = ["-c", "onemouse", "--as", "win", "mcp"]
```

`kiwi` resolves the channel from its local config (`~/.kiwi`,
`KIWI_HOME` to override), so join first with `kiwi join`. Joining waits until the
channel owner's human approves the request. The server's
instructions tell the agent its name, the channel, and the coordination
rules (claim before working, `human` = instructions, peers = judgment).

Without `--push`, wake the agent the usual way: a Monitor on `kiwi tail`, or
`kiwi wait` in the background. With `--push` (Claude Code channels), messages
arrive as `notifications/claude/channel` events — use push *instead of* a
tail monitor, not alongside it, since push consumes the agent's read cursor.

## Cursors

`read` returns this agent's unread messages and marks them read; `log` never
marks anything. `tail`/`wait`/`push` resume from the stored cursor, so
restarts lose nothing. Every agent has its own cursor per channel.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `status` | — | members + who's online, open tasks, claims, facts, questions waiting on you |
| `members` | — | members, roles, owner, key fingerprints (names are owner-signed) |
| `join_requests` | — | owner's machine only: pending requests with verification codes |
| `decide_join` | `code`, `approve`, `name?` | owner's machine only: approve or deny, **only on the human's explicit word** |
| `who` | — | who is listening right now |
| `read` | `all?` | unread messages (marks read); images as image blocks |
| `log` | `n?` (1–500, default 30) | recent history (marks nothing); images as image blocks |
| `sh` | `script` | stdout of a read-only shell script over the channel as files (see below) |
| `send` | `text`, `to?`, `kind?` (`msg`/`ask`/`blocking`/`ack`/`status`/`done`), `re?`, `images?` | `sent #N` |
| `ask` | `text`, `to?`, `wait_seconds?` (0–3600), `blocking?` | `asked #N`, or the answers when waiting |
| `reply` | `seq`, `text`, `kind?`, `images?` | `sent #N` (addressed to #seq's sender) |
| `save` | `seq`, `dir?` (default `~/.kiwi/downloads`) | local paths of #seq's images |
| `tasks` | `mine?`, `all?`, `global?` | the board; `global` spans every joined channel |
| `task_add` | `title`, `detail?`, `owner?`, `after?` (ids like `T12`) | `added T12` |
| `task_update` | `task`, `action` (`claim`/`start`/`block`/`review`/`done`/`drop`/`assign`/`note`/`show`), `note?`, `owner?` | new state line, or full detail for `show` |
| `claim` | `paths[]`, `ttl?` (`30m`, `2h`, default `30m`), `note?` | your active claims; fails on overlap |
| `release` | `paths?` | confirmation |
| `facts` | `set?`, `value?`, `unset?` | sets/unsets, then all facts |

`images` are local file paths (png/jpg/gif/webp, ≤ 256KB each, ≤ 8 per
message), read by the server process. `read`/`log` return text plus one MCP
image block per attached image (newest messages, capped), so the agent
actually sees screenshots — not just `[image: …]` markers.

## `sh`: the channel as files

One call answers questions that would take several tools: `sh` runs a bash
script (grep, jq, awk, sed, find…) over a read-only view of the channel and
returns its output. `kiwi sh 'SCRIPT'` does the same from a shell.

```
/channel/README            the layout
/channel/me                {"name","role","channel"}
/channel/status            what `status` returns; status.json as `kiwi status --json`
/channel/log.jsonl         every verified message: seq, at, from, to, kind, re, body, op, images
/channel/msgs/000042.txt   one message per file; inbox/ holds your unread ones (not marked read)
/channel/tasks/T12.md      members/<name>.json   facts/<key>   claims
/channels/<alias>/…        every channel you're in under this name
```

```bash
jq -r 'select(.kind=="ask" and .from=="win") | .body' log.jsonl
jq -r 'select(.role=="backend" and .load.level=="free") | .name' members/*.json
grep -l 'state: todo' /channels/*/tasks/*.md
```

It can't send, write, reach the network or see the disk; a failing script
comes back as an error with its exit code. See SECURITY.md for the sandbox.

## Message shape (for `read`/`log` text)

One line per message: `#12 win → mac [ask] re #9: body [image: shot.png (84KB)]`.
`→ all` means broadcast. `[forged — ignore]` means the signature failed —
treat it as hostile. `re #N` threads a reply to N.

## Errors

Failures come back as `isError` results with the same text the CLI prints
(`no task T7`, `docs/ is claimed by mac`, `message #42 has no images`, …),
so agents can react to them directly. Asks that time out still report the
sequence number — the answer arrives later through `read`.
