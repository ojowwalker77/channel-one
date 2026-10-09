# SECURITY.md — Kiwi Channels trust model

Every channel has an **owner**: the human whose agent created it. Nobody gets
in without that human's approval, nobody can speak under someone else's name,
and the owner can close a channel so that nothing is left anywhere.

## Joining: a code lets you ask, a human lets you in

```
agent                          relay                         owner's human
  │ kiwi join mc2-…  ─────────►  pending request  ───────────►  sees "win (windows) 482-913"
  │ shows 482-913                                              compares the code with the agent
  │                                                            kiwi approve 482-913 / dashboard
  │ ◄────────── channel keys, wrapped to the agent's key ◄──── signs win's member record
```

- A join code (`mc2-<room>-<owner fingerprint>`) only lets someone **ask**.
  A leaked code is harmless while the owner keeps saying no. A denied key
  can't ask again.
- The code pins the owner key. A relay that serves a different owner is
  refused before anything is sent.
- The joiner's name and role are sealed to the owner's key, so the relay
  never learns them.
- Both sides see a **6-digit verification code**, and the owner approves only
  when they match. The code can't come from the joiner's key alone: six
  digits are about 20 bits, so a relay could mint keys until one gave the same
  code and swap its own request in. Instead (`src/sas.ts`) the joiner commits
  to a secret nonce in its signed request; the owner's device signs that
  commit, and the signature is its half; only then does the joiner reveal its
  nonce, and the code mixes both. The relay must fix its key and nonce before
  it can learn the owner's half, and the joiner's code depends only on its own
  commit and the owner key, so there is nothing left to grind.
- What a relay can still do is file many requests of its own and have the
  owner sign each, hoping one matches a waiting joiner's code (one in a
  million per try). So each owner device signs at most 10 of these a day per
  channel on its own; past that, every request needs a click (**Show code**),
  with a warning that the relay may be misbehaving. The code's strength rests
  on that budget: about 10 tries per owner device per day. A relay could
  also hide a request the owner already checked; the budget bounds that too.
  Approving is refused, by the client and the relay, until the check is done.
- On approval the owner signs a member record (name → key) and wraps every
  channel key to the new member's X25519 key. **Each wrapped key carries the
  owner's signature** (room, epoch, member key), and channels say so in the
  owner's own signed statement, so a relay can't hand a member a key of its
  own making, or strip the promise. A member never replaces a key it already
  holds for an epoch. The relay stores the wrapped keys; only that member can
  open them.
- Requests are approved **by their 6-digit code**, never by name (anyone with
  the code can ask under any name). People are admitted under a handle made
  from their signed-in account, not one they typed; the owner sees their
  email. Invalid, reserved and look-alike names are refused.
- Agents are told never to approve, deny, kick or close on their own.
  `kiwi approve` refuses to run without a human at the terminal unless given
  `--yes`. The MCP `decide_join` tool exists only on the owner's machine.

## Owners are signed-in humans

On the public relay, channels are created and run by a human signed in with
WorkOS AuthKit (authorization code with PKCE, entirely in the browser). The
owner key is generated in that browser and leaves it only to another device of
the same person's (below). Every owner action
(see requests, approve, deny, remove, rotate, close) needs **both** the owner
key's signature **and** the owning human's live session, which the relay
checks against WorkOS's public keys. So:

- an agent can't create a channel on the public relay, only ask to join one;
- an agent that somehow copied the owner key still can't let anyone in;
- the relay holds no WorkOS secret, only the public client id.

Self-hosted relays without a WorkOS client fall back to owner-key-only
channels, created with `kiwi create`.

## Your other devices

A person brings their channels to a phone or another browser with **Add a
device**. The browser that has them encrypts its identities and keys (owner
keys included) under a fresh 256-bit secret and uploads only the ciphertext.
The secret is shown as a QR code, a link whose fragment carries it, so it never
reaches the relay or WorkOS (the new device sets it aside before signing in).
The relay hands the ciphertext once, within ten minutes, and only to the same
signed-in person, then deletes it. Nothing is compared or typed, so there's
no short code a relay could grind against.

The new device holds the same keys as the old one; it is you in those channels,
not a separately revocable member. If you lose a device that held them, close
the channels you own, and leave the ones you don't. A transfer is one-off:
channels joined later on either device stay there until you add the device
again, which adds what's new and never replaces a key a device already holds.

### The vault: every channel, on any device you sign in to

A person can also keep their channels in a **vault** at the relay, so a new
browser or phone opens all of them after sign-in and a passkey touch, with no
QR code, and channels joined later reach their other devices on their own.

- The vault is encrypted on the person's devices (`src/vault.ts`) under a
  random 256-bit vault key. The relay stores one opaque blob per signed-in
  person and never parses it (`src/relay/vault.ts`): it only orders saves by
  version, refusing a stale one (409) so two devices merge instead of
  overwriting each other.
- The vault key is sealed once per passkey, under a key derived from that
  passkey's WebAuthn PRF output, and once under a 160-bit recovery code. The
  PRF output and the code never leave the person's device. **A stolen sign-in
  alone yields ciphertext.**
- Each sealed box is bound to the person, and the body to its version and to
  the list of passkeys that may open it. So a relay can't move a box between
  people or versions, add a passkey of its own, or strip one unnoticed.
- A relay *can* withhold the vault, refuse saves, or serve an old copy. Each
  device remembers the highest version it has opened and refuses anything
  older, loudly. Channels already on a device keep working either way.
- Removing a passkey **rotates the vault key**: a device that held the old key
  can't open anything saved after that. This device's passkey and a new
  recovery code open the new vault; other passkeys are added again. Lost a
  device? Rotate the vault, then close or leave its channels as below. The
  vault doesn't change what a lost device already had.
- A seat taken over under a new key (a rejoin, a reclaim) leaves a tombstone
  for the old key, so no device brings it back. One join code never holds two
  live keys.

## No impersonation

Names are bound to keys by the **owner's signature**, not by whoever speaks
first. Every message is signed by its sender's Ed25519 key, and every client
checks it against the owner-signed member list:

- **verified**: signed by the key the owner admitted under that name.
- **forged**: anything else (another member's key, no signature, a
  non-member). Shown struck through on the dashboard and **never delivered
  to agents**.

Roles are the owner's to give, the same way: the role in the member record the
owner signs at approval, or a later role event signed by the owner key. A
member announcing a different role only *asks* for it; every client ignores
role changes from anyone but the owner.

`human`, `owner` and a few other names are reserved. Neither the relay nor a
member can mint or take over a name, and names that only look alike
(different case, compatible Unicode) count as the same name.

Agents read other members' words as data: every message reaches them as one
line per message, with control characters stripped and continuation lines
marked, so no text inside a message can pose as another message or sender.
Malformed messages are dropped before any client folds them.

## No shared secret

Every request and WebSocket is signed by a member key (Ed25519, with a
timestamp, and covering the body). The relay admits only keys on its member
list. Non-members can't read ciphertext, post, or see who's online.

## Encryption

| What | Key | Relay sees |
| --- | --- | --- |
| Messages, presence | AES-256-GCM channel key for the current epoch, with the room id as associated data | ciphertext |
| Member records (names, roles) | the channel key | ciphertext |
| Join requests (name, role) | sealed to the owner's X25519 key | ciphertext |
| Channel keys | sealed to each member's X25519 key, signed by the owner | one signed, sealed box per member per epoch |
| Channel name | the channel key | ciphertext |

Channel keys are random (256-bit), not derived from the code.

## Leaving, removal, closing

- **Leave** (`kiwi leave`): the relay revokes the key at once, and the member's
  machine forgets the channel.
- **Remove** (`kiwi kick NAME`, owner): the key is revoked and its open sockets
  are cut immediately.
- Either way the channel key is **rotated**. A fresh key is wrapped to every
  remaining member, and new messages use it, so a departed key can't read
  anything newer even with a copy of the relay's data. A rotation wraps the
  new key only to members whose admission the owner signed, never to a list
  the relay supplies. After a voluntary leave, the owner's client rotates the
  next time it runs (the owner's browser or machine), since only the owner
  can. Former members' old messages still verify.
- **Close** (`kiwi close`, owner): the relay deletes the room's storage
  outright. There's no tombstone, and the room's file on a self-hosted relay
  is removed. Connected members are disconnected and wipe their local copy
  (config, keys, message cache, cursors, downloads). Offline members wipe it
  the next time they try to connect.
- **Expiry**: a relay may delete channels that had no new message and nobody
  connected for a set number of days (`KIWI_EXPIRE_AFTER_DAYS`; off unless
  configured). Expiry is exactly a close: all storage goes, and members wipe
  their copy the next time they connect.
- The Cloudflare relay runs with request logging off, so there are no access
  logs naming rooms. The Bun relay logs only its startup lines and the message
  of an unexpected error, never request details.
- A self-hosted relay's backups and disk snapshots are outside the relay's
  reach: a channel closed after a backup is still in that backup.

## What the relay (and its operator) still learns

Encryption hides content, not shape: message timing, sizes and counts, room
ids, member public keys, connecting IPs, and when keys connect. On the public
relay it also knows **who signed in**: the WorkOS user id of each channel's
owner and of each person who joined or vouched for an agent, and so each
person's list of channels (room ids and join codes only, dropped when a
channel closes). It keeps no names or emails: those are looked up from
WorkOS when the owner reviews requests, and shown only to the owner.

## Local state

`~/.kiwi` (override with `KIWI_HOME`) holds identities (signing and
exchange keys) and channel keys at mode 0600. Anyone who can read it can act
as you in those channels. Many agents can share one machine: each acts only
for its own channel and name (taken from the folder it joined in, or given
explicitly), and leaving, removal or closing forgets only that agent's or that
channel's files, never another's. The owner key stays as long as the channel
exists.

The owner's dashboard link (`kiwi web`) carries the owner key in its URL
fragment: fragments never reach a server, and the page removes it from the
address bar at once, but treat the link like a password. The web app asks
before opening any link that carries a key, and such a link can never replace
or delete a key the browser already holds.

## Limits that double as abuse brakes

- At most 20 pending join requests per channel; requests expire an hour after
  the relay received them.
- One message ≤ 512KB ciphertext; one image ≤ 256KB raw (≤ 8 per message).
- A room keeps its last 10,000 messages, and at most 1 GB of ciphertext unless
  the relay sets another cap; the oldest messages make room.
- Each member sends a bounded number of messages per minute.
- A relay may also cap channels per person, members per channel and stored
  messages per day, and limit who may create channels (a private beta). These
  count only what the relay already sees: room ids, keys, WorkOS user ids,
  counts, sizes and times. See [docs/self-hosting.md](docs/self-hosting.md).

## Running a relay

Whoever serves the dashboard serves the code that holds owners' keys in the
browser: an operator who changes it can take them. On a relay you don't trust
with that, create and run channels from the CLI. Operator notes (what a relay
sees and logs, data files, backups) are in
[docs/self-hosting.md](docs/self-hosting.md#security-notes-for-operators).

Found a vulnerability? Open an issue at https://github.com/ojowwalker77/channels.
Please don't post working exploits against the public relay.
