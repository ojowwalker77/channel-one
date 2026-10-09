# Plan: private-beta gate, per-person quotas, and self-hosting docs

> Owner's brief, as written. Since it was written the project was renamed: the CLI is
> `kiwi` (not `mc`), env vars are `KIWI_*` (not `MC_*`), the public relay is
> https://channels.kiwiinit.com, the repo is ojowwalker77/channels, `install.sh` downloads
> attested release binaries (no `MC_REPO`), and computers are linked with `kiwi setup`
> (agents on sign-in relays must join from a linked computer). Read the brief through that lens.
> The brief arrived cut off at its last line ("Don't deploy to the public relay, and don't change").

The public relay is about to be shared publicly. The owner is paying out of pocket in Brazil and
needs Cloudflare costs to be **bounded**. Deliver: (1) an invite-only beta gate, (2) per-person
quotas that become the future free tier, (3) first-class documentation for self-hosting.

## Hard constraints
- Never weaken end-to-end encryption. Quotas may use only what the relay already sees: room ids,
  member public keys, WorkOS user ids, counts, byte sizes, timestamps. No new plaintext fields.
- All logic in `src/relay/room.ts` or a shared module next to it; both relays behave identically
  and the same tests pass against both.
- Configurable, off by default for self-hosters (no allowlist → anyone signed in can create; no
  quota → no limit, except the always-on safety caps). The public relay turns it all on via
  `wrangler.jsonc`. Self-hosted relays without WorkOS keep working exactly as today.
- Keep the style: small functions, comments that explain why, no new dependencies.
- Don't break the wire protocol. New errors: 403 not allowed, 429 over quota, 413 too large.

## Part 1: beta gate
- `BETA_USERS`: comma-separated WorkOS user ids (optionally emails / email domains, via the
  WorkOS profile lookup). When set, `POST /create` from a signed-in user not on the list → 403
  with a clear message and a configurable waitlist URL.
- Joining existing channels is not gated (beta users bring collaborators).
- The dashboard shows the error nicely where "create channel" lives.
- Bun relay accepts the same settings (flags/env) and its entry point exposes `--hostname` and
  WorkOS settings.

## Part 2: per-person quotas [public-relay defaults]
1. Channels owned per person [2], checked on create (Directory DO / people.sqlite); closing frees a slot.
2. Active members per channel [8], checked in approve.
3. Stored messages per channel per UTC day [2,000]: counter in the room's meta, reset by date,
   checked in append (WebSocket send and HTTP POST). Over → 429 saying when it resets. Ephemeral
   frames don't count.
4. Stored bytes per channel [50 MB]: total ciphertext of retained messages, correct across
   retention pruning. Over → 413/429 with a clear message.

Always-on safety caps: a byte cap with a sane default for everyone (about 1 GB, overridable), and
inactive room expiry (no stored message and no connection for N days [90 public; off self-hosted]),
via a Durable Object alarm (Worker) or a periodic sweep (Bun). Expiry behaves exactly like close:
wipe all storage and `unlinkAll`.

Errors reach people clearly: the CLI prints one line, MCP tools return the reason, the dashboard
shows it inline, and agents never retry-loop on a 429.

`GET /v1/me/usage` for signed-in users: channels owned vs the limit; per owned channel: messages
today, bytes, members. Shown in a small spot on the dashboard.

## Part 3: docs/self-hosting.md (every command actually run), linked from README
When to self-host; Bun relay (flags, data layout, backups); putting it on the internet (TLS,
Caddy, systemd, optional Docker); dashboard on a self-hosted relay (serve web/dist with an SPA
fallback from bun.ts, preferred over documenting the gap); your own Cloudflare Worker (wrangler,
migrations stay, Free vs Paid limits, billing alerts, rate limiting on /v1/*); optional sign-in
with your own WorkOS app (redirect URI /auth/callback); a table of every beta/quota setting;
pointing clients at your relay (--relay / KIWI_RELAY, remembered per channel; installing the CLI,
forks); security notes for operators (what they see, what the Bun relay logs, whoever serves the
dashboard JS controls the code holding the owner key). Update SECURITY.md and README.md where
promises change (e.g. expiry deletes everything like close).

## Tests
Every rule: allowlist on/off; each quota at the limit and one past; daily reset with an injected
clock; byte counter correct after pruning; expiry wiping room and directory entries;
/v1/me/usage; self-hosted defaults unchanged. Fake WorkOS verifier as in test/human.test.ts.
All on the Bun relay; also against `wrangler dev` if it runs, else say so.

## Done means
bun test + typecheck pass; no new config → unchanged behavior apart from the safety caps (state
which defaults changed); wrangler.jsonc enables beta + quotas with the bracketed defaults,
commented; docs/self-hosting.md exists with every command executed; small focused commits in
order gate → quotas → expiry → usage + dashboard → Bun static serving → docs; a short summary
with config keys, documented limitations, and open questions. Don't deploy to the public relay.
