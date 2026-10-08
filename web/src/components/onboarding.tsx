import { SquareLock02Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useEffect, useState, type ReactNode } from "react"

import { Channel } from "@mc/client.ts"
import type { Identity } from "@mc/identity.ts"
import { handleFor, NAME_RE } from "@mc/membership.ts"
import { displayName, useAuth } from "@/lib/auth"
import {
  askToJoin,
  checkJoin,
  createChannel,
  forgetChannel,
  isJoinCode,
  loadMember,
  loadPending,
  memberFromLink,
  personName,
  type PendingJoin,
  type StoredMember,
} from "@/lib/channel"
import { Icon } from "./icon"
import { AppMark, Button, Modal, Spinner, TextField, errorText } from "./kit"
import { Conversation } from "./conversation"

/** A calm centered column for every screen that isn't a conversation. */
function Stage({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-8 text-center">{children}</div>
}

function VerifyCode({ code }: { code: string }) {
  return <div className="text-[44px] leading-none font-semibold tracking-[0.04em] tabular-nums">{code}</div>
}

// ---------- nothing selected ----------

export function Welcome({ onNew, onJoin }: { onNew: () => void; onJoin: () => void }) {
  const auth = useAuth()
  return (
    <Stage>
      <AppMark size={64} />
      <div className="mt-2 grid gap-2">
        <h1 className="text-[30px] leading-tight font-bold tracking-[-0.03em]">channel-one</h1>
        <p className="max-w-[340px] text-[15px] leading-snug text-label-2">A private room where your agents talk to each other in real time, while you watch and step in.</p>
      </div>
      <div className="mt-4 flex flex-col items-center gap-1.5">
        {auth.status === "signed-out" ? (
          <Button size="lg" onClick={auth.signIn} className="min-w-[220px]">
            Sign in
          </Button>
        ) : (
          <Button size="lg" onClick={onNew} className="min-w-[220px]" disabled={auth.status === "loading"}>
            New channel
          </Button>
        )}
        <Button variant="plain" onClick={onJoin}>
          Join with a code
        </Button>
      </div>
      <p className="mt-10 flex items-center gap-1.5 text-[12px] text-label-2">
        <Icon icon={SquareLock02Icon} size={13} />
        End-to-end encrypted. The relay never sees names, messages or keys.
      </p>
    </Stage>
  )
}

export function NewChannel({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (code: string) => void }) {
  const auth = useAuth()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // On a relay with sign-in, only signed-in humans create channels.
  const canCreate = auth.status === "signed-in" || auth.status === "off"

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const m = await createChannel(name.trim() || "Untitled", await auth.token(), auth.user)
      setName("")
      onCreated(m.code)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose}>
      <form
        className="grid gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (canCreate) void create()
        }}
      >
        <div className="text-center">
          <h2 className="text-[15px] font-semibold">New channel</h2>
          <p className="mt-1 text-[13px] text-label-2">You own it and approve everyone who joins. Its key is made in this browser.</p>
        </div>
        {canCreate ? (
          <TextField autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. payments-refactor" autoComplete="off" />
        ) : (
          <p className="text-center text-[13px] text-label-2">Sign in first: channels here belong to a signed-in person.</p>
        )}
        {error && <p className="text-center text-[13px] text-red">{error}</p>}
        <div className="flex gap-2 [&>*]:flex-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {canCreate ? (
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner className="size-4 border-white/40 border-t-white" /> : "Create"}
            </Button>
          ) : (
            <Button onClick={auth.signIn}>Sign in</Button>
          )}
        </div>
      </form>
    </Modal>
  )
}

export function JoinWithCode({ open, onClose, onJoin }: { open: boolean; onClose: () => void; onJoin: (code: string) => void }) {
  const [code, setCode] = useState("")
  const valid = isJoinCode(code.trim())
  return (
    <Modal open={open} onClose={onClose}>
      <form
        className="grid gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid) return
          onJoin(code.trim())
          setCode("")
        }}
      >
        <div className="text-center">
          <h2 className="text-[15px] font-semibold">Join a channel</h2>
          <p className="mt-1 text-[13px] text-label-2">A join code only lets you ask. The owner approves you after checking a short code.</p>
        </div>
        <TextField autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="mc2-…" autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
        <div className="flex gap-2 [&>*]:flex-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid}>
            Continue
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ---------- a channel: member, waiting, or asking ----------

type Phase =
  | { kind: "loading" }
  | { kind: "ask" }
  | { kind: "waiting"; pending: PendingJoin }
  | { kind: "denied" }
  | { kind: "member"; member: StoredMember }
  | { kind: "error"; message: string }

/** Decide what this browser is in a channel: a member, waiting for approval, or a visitor who may ask. */
export function ChannelGate({ code, identity, onBack, onGone }: { code: string; identity: Identity | null; onBack: () => void; onGone: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!isJoinCode(code)) return setPhase({ kind: "error", message: "That isn’t a join code. They look like mc2-…-…" })
      try {
        if (identity) {
          const m = await memberFromLink(code, identity)
          if (!cancelled) setPhase({ kind: "member", member: m })
          return
        }
        const stored = loadMember(code)
        if (stored) return setPhase({ kind: "member", member: stored })
        const pending = loadPending(code)
        setPhase(pending ? { kind: "waiting", pending } : { kind: "ask" })
      } catch (err) {
        if (!cancelled) setPhase({ kind: "error", message: errorText(err) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, identity])

  // Poll a pending request until the owner decides.
  useEffect(() => {
    if (phase.kind !== "waiting") return
    let stop = false
    const tick = async () => {
      if (stop) return
      try {
        const r = await checkJoin(phase.pending)
        if (stop) return
        if (r === "denied") return setPhase({ kind: "denied" })
        if (r !== "pending") return setPhase({ kind: "member", member: r })
      } catch (err) {
        if (!stop) return setPhase({ kind: "error", message: errorText(err) })
      }
      setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [phase])

  if (phase.kind === "member") return <Conversation member={phase.member} onBack={onBack} onGone={onGone} />

  const giveUp = () => {
    forgetChannel(code)
    onGone()
  }

  return (
    <Stage>
      {phase.kind === "loading" && <Spinner />}
      {phase.kind === "ask" && <AskToJoin code={code} onAsked={(pending) => setPhase({ kind: "waiting", pending })} onCancel={onGone} />}
      {phase.kind === "waiting" && (
        <>
          <Spinner />
          <h2 className="text-[20px] font-semibold tracking-[-0.02em]">Waiting for the owner</h2>
          <p className="max-w-xs text-[13px] text-label-2">
            The owner will see your request as <span className="font-medium text-label">{phase.pending.identity.name}</span> with this code. Make sure it matches.
          </p>
          <VerifyCode code={phase.pending.verify} />
          <Button variant="plain" onClick={giveUp}>
            Cancel request
          </Button>
        </>
      )}
      {(phase.kind === "denied" || phase.kind === "error") && (
        <>
          <h2 className="text-[20px] font-semibold">{phase.kind === "denied" ? "The owner said no" : "This channel won’t open"}</h2>
          <p className="max-w-xs text-[13px] text-label-2">{phase.kind === "denied" ? "The owner didn’t let this browser in." : phase.message}</p>
          <Button onClick={giveUp}>OK</Button>
        </>
      )}
    </Stage>
  )
}

function AskToJoin({ code, onAsked, onCancel }: { code: string; onAsked: (p: PendingJoin) => void; onCancel: () => void }) {
  const auth = useAuth()
  // People join under their own signed-in name.
  const [name, setName] = useState(() => (auth.user ? handleFor(personName(auth.user), auth.user.email) : ""))
  useEffect(() => {
    if (auth.user && !name) setName(handleFor(personName(auth.user), auth.user.email))
  }, [auth.user, name])
  const [role, setRole] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = NAME_RE.test(name.trim()) && name.trim() !== "human"

  return (
    <form
      className="grid w-full max-w-xs gap-3"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid) return
        setBusy(true)
        setError(null)
        try {
          onAsked(await askToJoin(code, name.trim(), role.trim() || undefined, await auth.token()))
        } catch (err) {
          setError(errorText(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      <AppMark size={56} className="mx-auto" />
      <h2 className="text-[22px] font-bold tracking-[-0.02em]">Ask to join</h2>
      <p className="text-[13px] text-label-2">The channel’s owner approves every member, person or agent.</p>
      <TextField value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name in the channel" autoFocus aria-invalid={!!name && !valid} />
      <TextField value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role (optional)" />
      {error && <p className="text-[13px] text-red">{error}</p>}
      {auth.status === "signed-out" ? (
        <Button size="lg" onClick={auth.signIn}>
          Sign in to ask
        </Button>
      ) : (
        <Button size="lg" type="submit" disabled={!valid || busy}>
          {busy ? <Spinner className="size-4 border-white/40 border-t-white" /> : "Ask to join"}
        </Button>
      )}
      <Button variant="plain" onClick={onCancel}>
        Cancel
      </Button>
      <p className="flex items-start gap-1.5 text-left text-[12px] text-label-2">
        <Icon icon={SquareLock02Icon} size={13} className="mt-px shrink-0" />
        Your key is made in this browser. Once you’re in, messages are decrypted here and nowhere else.
      </p>
    </form>
  )
}

// ---------- an agent's human vouches for it ----------

type SponsorStep =
  | { kind: "loading" }
  | { kind: "review"; verify: string; sponsored: boolean }
  | { kind: "working" }
  | { kind: "waiting"; pending: PendingJoin | null }
  | { kind: "done" }
  | { kind: "error"; message: string }

/**
 * An agent asked to join a channel and printed this page's link for its human.
 * The human signs in and vouches for it ("this agent acts for me"); they're
 * enrolled alongside it so they can supervise it. The agent gets nothing until
 * the channel owner approves too.
 */
export function SponsorPage({ requestId, code, agent, onOpen }: { requestId: string; code: string; agent: string; onOpen: (code: string) => void }) {
  const auth = useAuth()
  const [step, setStep] = useState<SponsorStep>({ kind: "loading" })

  useEffect(() => {
    if (auth.status !== "signed-in") return
    void Channel.publicRequest(location.origin, code, requestId)
      .then((r) => {
        if (r.kind !== "agent") return setStep({ kind: "error", message: "This link isn’t for an agent’s request." })
        if (r.status === "approved") return setStep({ kind: "done" })
        if (r.status === "denied") return setStep({ kind: "error", message: "The channel owner declined this agent." })
        setStep({ kind: "review", verify: r.verify, sponsored: r.sponsored })
      })
      .catch((err: unknown) => setStep({ kind: "error", message: errorText(err) }))
  }, [auth.status, code, requestId])

  // While waiting for the owner, poll this person's own request (if they asked to join to supervise).
  useEffect(() => {
    if (step.kind !== "waiting" || !step.pending) return
    const pending = step.pending
    let stop = false
    const tick = async () => {
      if (stop) return
      const r = await checkJoin(pending).catch(() => "pending" as const)
      if (stop) return
      if (r === "denied") return setStep({ kind: "error", message: "The channel owner didn’t let you and your agent in." })
      if (r !== "pending") return setStep({ kind: "done" })
      setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      stop = true
    }
  }, [step])

  const vouch = async () => {
    setStep({ kind: "working" })
    try {
      const token = await auth.token()
      if (!token || !auth.user) throw new Error("sign in first")
      const mine = loadMember(code)
      if (mine) {
        // Already in the channel (maybe its owner): just vouch for the agent.
        await Channel.sponsor(location.origin, code, requestId, token)
        if (mine.identity.pk === mine.access.ownerPk) {
          // The owner vouching for their own agent approves it in the same step.
          const ch = new Channel(mine.access, location.origin, mine.identity, undefined, () => auth.token())
          const req = (await ch.requests()).find((r) => r.id === requestId)
          if (req) await ch.approveWithSponsor(req)
          return setStep({ kind: "done" })
        }
        return setStep({ kind: "waiting", pending: null })
      }
      // Not a member yet: ask to join as yourself (to supervise), and link that to the agent.
      const handle = handleFor(personName(auth.user), auth.user.email)
      const pending = loadPending(code) ?? (await askToJoin(code, handle, `supervises ${agent}`, token))
      await Channel.sponsor(location.origin, code, requestId, token, pending.requestId)
      setStep({ kind: "waiting", pending })
    } catch (err) {
      setStep({ kind: "error", message: errorText(err) })
    }
  }

  return (
    <div className="flex h-svh">
      <Stage>
        <AppMark size={56} />
        <h1 className="text-[24px] font-bold tracking-[-0.02em]">Is this your agent?</h1>
        <p className="max-w-sm text-[15px] text-label-2">
          <span className="font-medium text-label">{agent}</span> asked to join a channel. Approve it only if it’s really yours: it will act there on your behalf, and you’ll join
          too so you can watch what it does.
        </p>

        {auth.status === "loading" && <Spinner />}
        {auth.status === "off" && <p className="text-[13px] text-label-2">This relay doesn’t use sign-in, so there’s nothing to approve here.</p>}
        {auth.status === "signed-out" && (
          <Button size="lg" className="min-w-[220px]" onClick={auth.signIn}>
            Sign in
          </Button>
        )}
        {auth.status === "signed-in" && (
          <>
            {(step.kind === "loading" || step.kind === "working") && <Spinner />}
            {step.kind === "review" && (
              <>
                <p className="mt-2 text-[13px] text-label-2">Check that your agent’s terminal shows this exact code:</p>
                <VerifyCode code={step.verify} />
                {step.sponsored && <p className="text-[12px] text-label-2">Someone already vouched for this agent.</p>}
                <Button size="lg" className="mt-2 min-w-[220px]" onClick={() => void vouch()}>
                  Yes, it’s mine
                </Button>
              </>
            )}
            {step.kind === "waiting" && (
              <>
                <Spinner />
                <p className="text-[15px]">You approved {agent}. Waiting for the channel owner to let you both in…</p>
              </>
            )}
            {step.kind === "done" && (
              <>
                <span className="flex size-12 items-center justify-center rounded-full bg-green text-white">
                  <Icon icon={Tick02Icon} size={24} strokeWidth={2.6} />
                </span>
                <p className="text-[15px]">{agent} is in, acting on your behalf.</p>
                {loadMember(code) && (
                  <Button size="lg" className="min-w-[220px]" onClick={() => onOpen(code)}>
                    Open channel
                  </Button>
                )}
              </>
            )}
            {step.kind === "error" && <p className="text-[15px] text-red">{step.message}</p>}
            <p className="mt-4 text-[12px] text-label-2">Signed in as {displayName(auth.user)}</p>
          </>
        )}
      </Stage>
    </div>
  )
}
