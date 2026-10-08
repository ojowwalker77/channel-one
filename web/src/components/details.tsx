import { ChevronRightIcon, CopyIcon, LockIcon, XIcon } from "lucide-react"
import { useState } from "react"

import type { JoinRequest, Member as RosterMember } from "@mc/membership.ts"
import type { ChannelState } from "@mc/state.ts"
import { useAuth } from "@/lib/auth"
import { formatAgo, memberLine, memberName } from "@/lib/format"
import { Alert, Avatar, AvatarStack, Button, IconButton, Row, Section, errorText, toast } from "./kit"

export type Filter = { kind: "from"; name: string } | { kind: "open" } | { kind: "mine" }

type Confirm = { kind: "approve"; req: JoinRequest } | { kind: "remove"; member: RosterMember } | { kind: "close" } | { kind: "leave" } | null

interface Props {
  code: string
  title: string
  me: string
  isOwner: boolean
  roster: RosterMember[]
  requests: JoinRequest[]
  online: Map<string, unknown>
  state: ChannelState
  mentions: number
  now: number
  onFilter: (f: Filter) => void
  onApprove: (r: JoinRequest) => Promise<void>
  onDeny: (r: JoinRequest) => Promise<void>
  onRemove: (m: RosterMember) => Promise<void>
  onCloseChannel: () => Promise<void>
  onLeaveChannel: () => Promise<void>
  onDismiss: () => void
}

function minutesLeft(expires: number, now: number) {
  const m = Math.max(0, Math.round((expires - now) / 60_000))
  return m < 60 ? `${m}m left` : `${Math.floor(m / 60)}h ${m % 60}m left`
}

/** Everything about a channel behind the ⓘ button: people, requests, invites, claims, facts, and leaving. */
export function Details(p: Props) {
  const auth = useAuth()
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)
  const signInRelay = auth.status !== "off"
  const needsSignIn = p.isOwner && auth.status === "signed-out"
  // A person who asked to join to supervise their agent is shown inside the agent's request.
  const linked = new Set(p.requests.map((r) => r.sponsorRequest).filter(Boolean))
  const requests = p.requests.filter((r) => !linked.has(r.id))
  const active = p.roster.filter((m) => m.active).sort((a, b) => Number(b.owner) - Number(a.owner) || Number(p.online.has(b.name)) - Number(p.online.has(a.name)))
  const former = p.roster.filter((m) => !m.active)
  const facts = [...p.state.facts.values()].sort((a, b) => a.key.localeCompare(b.key))
  const joinCommand = `curl -fsSL ${location.origin}/install.sh | sh && ~/.bun/bin/mc join ${p.code} --as <name>`

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast(done)
      setConfirm(null)
    } catch (err) {
      const message = errorText(err)
      toast(/sign in required/.test(message) ? "Sign in to do that: owner actions need your session" : message, "error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="animate-slide-in flex h-full w-full flex-col overflow-hidden border-l border-separator bg-grouped md:w-[360px]">
      <header className="flex h-[52px] shrink-0 items-center justify-between px-3">
        <span className="w-8" />
        <span className="text-[15px] font-semibold">Details</span>
        <IconButton label="Close" onClick={p.onDismiss}>
          <XIcon />
        </IconButton>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto px-4 pb-8">
        <div className="flex flex-col items-center gap-2 pt-2 text-center">
          <AvatarStack names={active.filter((m) => m.name !== p.me).map((m) => memberName(m))} size={64} />
          <h2 className="text-[20px] font-semibold">{p.title}</h2>
          <p className="flex items-center gap-1 text-[12px] text-label-2">
            <LockIcon className="size-3" />
            End-to-end encrypted · {active.length} {active.length === 1 ? "member" : "members"}
          </p>
        </div>

        {needsSignIn && (
          <Section footer="Your owner key alone can’t approve, remove or close. That’s by design.">
            <Row>
              <span className="flex-1 text-[15px]">Sign in to manage this channel</span>
              <Button size="sm" onClick={auth.signIn}>
                Sign in
              </Button>
            </Row>
          </Section>
        )}

        {p.isOwner && requests.length > 0 && (
          <Section title="Waiting to join" footer="Approve only when the requester shows the same code. A leaked join code is harmless while you say no.">
            {requests.map((r) => {
              // On a sign-in relay, an agent needs its own human's vouch before you can let it in.
              const awaitingSponsor = signInRelay && r.kind !== "human" && !r.sponsoredBy
              const supervisor = r.sponsorRequest ? p.requests.find((x) => x.id === r.sponsorRequest) : undefined
              return (
                <div key={r.id} className="grid gap-2 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={r.name} size={36} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-medium">
                        {r.name}
                        {r.role && <span className="font-normal text-label-2"> · {r.role}</span>}
                      </p>
                      <p className="text-[12px] leading-snug text-label-2">
                        {r.kind === "human"
                          ? `Person · signed in as ${r.sponsoredBy?.name ?? "?"}`
                          : r.sponsoredBy
                            ? `Agent of ${r.sponsoredBy.name}${supervisor ? `, who joins too as @${supervisor.name}` : ""}`
                            : signInRelay
                              ? "Agent · waiting for its own human to approve it"
                              : "Agent"}{" "}
                        · {formatAgo(r.ts, p.now)}
                      </p>
                    </div>
                    <code className="rounded-md bg-fill-2 px-1.5 py-0.5 font-mono text-[13px] font-semibold tracking-wider">{r.code}</code>
                  </div>
                  <div className="flex gap-2 pl-12">
                    <Button size="sm" variant="secondary" className="flex-1" onClick={() => run(() => p.onDeny(r), `Declined ${r.name}`)}>
                      Decline
                    </Button>
                    <Button size="sm" className="flex-1" disabled={awaitingSponsor} title={awaitingSponsor ? "Its human hasn’t approved it yet" : undefined} onClick={() => setConfirm({ kind: "approve", req: r })}>
                      Approve
                    </Button>
                  </div>
                </div>
              )
            })}
          </Section>
        )}

        <Section title="Members">
          {active.map((m) => (
            <div key={m.pk} className="group flex min-h-12 items-center gap-3 px-4 py-2">
              <Avatar name={memberName(m)} size={32} online={p.online.has(m.name)} />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => p.onFilter({ kind: "from", name: m.name })} title="Show only their messages">
                <p className="truncate text-[15px]">
                  {memberName(m)}
                  {m.name === p.me && <span className="text-label-2"> (you)</span>}
                </p>
                <p className="truncate text-[12px] text-label-2">
                  {memberLine(m)} · key {m.pk.slice(0, 8)}
                </p>
              </button>
              {p.isOwner && !m.owner && (
                <Button size="sm" variant="danger" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => setConfirm({ kind: "remove", member: m })}>
                  Remove
                </Button>
              )}
            </div>
          ))}
          {former.length > 0 && <div className="px-4 py-2 text-[12px] text-label-2">Former: {former.map((m) => m.name).join(", ")}</div>}
        </Section>

        <Section>
          <Row onClick={() => p.onFilter({ kind: "open" })}>
            <span className="flex-1 text-[15px]">Open questions</span>
            <span className="text-[15px] text-label-2">{p.state.openAsks.length}</span>
            <ChevronRightIcon className="size-4 text-label-3" />
          </Row>
          <Row onClick={() => p.onFilter({ kind: "mine" })}>
            <span className="flex-1 text-[15px]">Messages to you</span>
            <span className="text-[15px] text-label-2">{p.mentions}</span>
            <ChevronRightIcon className="size-4 text-label-3" />
          </Row>
        </Section>

        {p.isOwner && (
          <Section title="Invite an agent" footer="It installs channel-one and asks to join. Its request shows up here with a code to check.">
            <div className="flex items-start gap-2 px-4 py-3">
              <code className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed break-all text-label-2">{joinCommand}</code>
              <IconButton label="Copy" tone="blue" onClick={() => navigator.clipboard.writeText(joinCommand).then(() => toast("Copied. Replace <name> with the agent’s name"))}>
                <CopyIcon />
              </IconButton>
            </div>
          </Section>
        )}

        {p.state.claims.length > 0 && (
          <Section title="Claimed paths">
            {p.state.claims.map((c) => (
              <div key={`${c.owner}:${c.path}`} className="px-4 py-2">
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{c.path}</code>
                  <span className="shrink-0 text-[12px] text-label-2">{minutesLeft(c.expires, p.now)}</span>
                </div>
                <p className="truncate text-[12px] text-label-2">
                  {c.owner}
                  {c.note ? ` · ${c.note}` : ""}
                </p>
              </div>
            ))}
          </Section>
        )}

        {facts.length > 0 && (
          <Section title="Facts">
            {facts.map((f) => (
              <button
                key={f.key}
                type="button"
                className="block w-full px-4 py-2 text-left hover:bg-fill-2"
                title="Copy value"
                onClick={() => navigator.clipboard.writeText(f.value).then(() => toast(`Copied ${f.key}`))}
              >
                <p className="font-mono text-[13px] font-medium">{f.key}</p>
                <p className="font-mono text-[12px] break-all text-label-2">{f.value}</p>
              </button>
            ))}
          </Section>
        )}

        <Section
          footer={
            p.isOwner
              ? "Deletes every message, member and key at the relay. Members’ copies are wiped when they next connect."
              : "You lose access at once. The owner rotates the key so you can’t read anything newer."
          }
        >
          <Row onClick={() => setConfirm({ kind: p.isOwner ? "close" : "leave" })}>
            <span className="flex-1 text-[15px] text-red">{p.isOwner ? "Close Channel" : "Leave Channel"}</span>
          </Row>
        </Section>
      </div>

      <Alert
        open={confirm?.kind === "approve"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "approve" ? `Let ${confirm.req.name} in?` : ""}
        message={
          confirm?.kind === "approve" && (
            <>
              {confirm.req.sponsoredBy && confirm.req.kind !== "human" ? <>Agent of {confirm.req.sponsoredBy.name}. </> : null}
              Check that it shows exactly this code.
              <span className="mt-3 block font-mono text-[28px] font-semibold tracking-widest text-label">{confirm.req.code}</span>
            </>
          )
        }
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        {confirm?.kind === "approve" && (
          <Button
            disabled={busy || active.some((m) => m.name === confirm.req.name)}
            onClick={() => run(() => p.onApprove(confirm.req), `${confirm.req.name} joined`)}
          >
            {active.some((m) => m.name === confirm.req.name) ? "Name taken" : "Approve"}
          </Button>
        )}
      </Alert>

      <Alert
        open={confirm?.kind === "remove"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "remove" ? `Remove ${memberName(confirm.member)}?` : ""}
        message="They’re disconnected at once, and the key rotates so they can’t read anything new."
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        {confirm?.kind === "remove" && (
          <Button variant="destructive" disabled={busy} onClick={() => run(() => p.onRemove(confirm.member), `Removed ${confirm.member.name}`)}>
            Remove
          </Button>
        )}
      </Alert>

      <Alert
        open={confirm?.kind === "close" || confirm?.kind === "leave"}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "close" ? "Close this channel for everyone?" : "Leave this channel?"}
        message={confirm?.kind === "close" ? "Everything is deleted. This can’t be undone." : "You’ll need the owner’s approval to come back."}
      >
        <Button variant="secondary" onClick={() => setConfirm(null)}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => run(confirm?.kind === "close" ? p.onCloseChannel : p.onLeaveChannel, confirm?.kind === "close" ? "Channel closed" : "You left the channel")}
        >
          {confirm?.kind === "close" ? "Close" : "Leave"}
        </Button>
      </Alert>
    </aside>
  )
}
