import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { useState } from "react"

import { describeEvent } from "@mc/format.ts"
import type { Message, TaskState } from "@mc/protocol.ts"
import { taskId, waitingOn, type ChannelState, type Task } from "@mc/state.ts"
import { formatAgo, formatFull } from "@/lib/format"
import { cx } from "@/lib/utils"
import { Icon } from "./icon"
import { Alert, Button, IconButton, Modal, errorText, toast } from "./kit"
import { Markdown } from "./markdown"

const LABEL: Record<TaskState, string> = { doing: "In progress", blocked: "Blocked", review: "In review", todo: "To do", done: "Done", cancelled: "Cancelled" }
const ORDER: TaskState[] = ["blocked", "doing", "review", "todo", "done", "cancelled"]

/** A task's state as a small circle: empty, half full, dashed, red, or checked. Ink only, except blocked. */
function StateMark({ state }: { state: TaskState }) {
  if (state === "done") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-ink text-canvas">
        <Icon icon={Tick02Icon} size={11} strokeWidth={2.6} />
      </span>
    )
  }
  if (state === "cancelled") {
    return <span title="Cancelled" className="block size-4 shrink-0 rounded-full border-[1.5px] border-ink-3 opacity-60" />
  }
  return (
    <span
      title={LABEL[state]}
      className={cx(
        "block size-4 shrink-0 rounded-full border-[1.5px]",
        state === "todo" && "border-ink-3",
        state === "doing" && "border-ink-2 bg-[conic-gradient(var(--ink-2)_0_50%,transparent_50%_100%)]",
        state === "review" && "border-dashed border-ink-2",
        state === "blocked" && "border-alert bg-[radial-gradient(var(--alert)_0_38%,transparent_40%)]"
      )}
    />
  )
}

function TaskRow({ task, state, now, onOpen }: { task: Task; state: ChannelState; now: number; onOpen: () => void }) {
  const waits = waitingOn(state, task)
  return (
    <button type="button" onClick={onOpen} className="-mx-3 flex w-[calc(100%+24px)] items-start gap-3 rounded-[8px] px-3 py-2 text-left transition-colors hover:bg-wash">
      <span className="flex pt-[3px]">
        <StateMark state={task.state} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx("block text-[14px] leading-snug", (task.state === "done" || task.state === "cancelled") && "text-ink-2")}>{task.title}</span>
        <span className="mt-0.5 flex items-center gap-3 text-[12px] text-ink-3">
          <span className="tabular-nums">{taskId(task.id)}</span>
          <span className="truncate">{task.owner ?? "Unassigned"}</span>
          {waits.length > 0 && <span className="shrink-0">Waits on {waits.map(taskId).join(", ")}</span>}
          {task.notes.length > 0 && <span className="shrink-0">{task.notes.length === 1 ? "1 note" : `${task.notes.length} notes`}</span>}
          <span className="ml-auto shrink-0">{formatAgo(task.updatedAt, now)}</span>
        </span>
      </span>
    </button>
  )
}

function minutesLeft(expires: number, now: number) {
  const m = Math.max(0, Math.round((expires - now) / 60_000))
  return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`
}

/** What's held and what's known: claimed paths, and the facts agents set for each other. */
function Board({ state, now, onForgetFact }: { state: ChannelState; now: number; onForgetFact: (key: string) => Promise<void> }) {
  const facts = [...state.facts.values()].sort((a, b) => a.key.localeCompare(b.key))
  const [clearing, setClearing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!state.claims.length && !facts.length) return null
  const clear = async (key: string) => {
    setBusy(true)
    try {
      await onForgetFact(key)
      toast(`Cleared ${key}`)
      setClearing(null)
    } catch (err) {
      toast(`Not cleared: ${errorText(err)}`, "error")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-2 grid gap-7 border-t border-line pt-6 md:grid-cols-2">
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h3 className="text-[13px] font-semibold">Claimed paths</h3>
          <span className="text-[12px] text-ink-3 tabular-nums">{state.claims.length}</span>
        </div>
        {state.claims.length === 0 && <p className="text-[12.5px] text-ink-3">Nobody’s holding a path.</p>}
        {state.claims.map((c) => (
          <div key={`${c.owner}:${c.path}`} className="py-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <code className="truncate font-mono text-[12px]">{c.path}</code>
              <span className="shrink-0 text-[11.5px] text-ink-3">{minutesLeft(c.expires, now)}</span>
            </div>
            <p className="truncate text-[12px] text-ink-2">{c.note ? `${c.owner}: ${c.note}` : c.owner}</p>
          </div>
        ))}
      </section>
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h3 className="text-[13px] font-semibold">Facts</h3>
          <span className="text-[12px] text-ink-3 tabular-nums">{facts.length}</span>
        </div>
        {facts.length === 0 && <p className="text-[12.5px] text-ink-3">No shared values yet.</p>}
        {facts.map((f) => (
          <div key={f.key} className="group -mx-2 flex items-start gap-1 rounded-[8px] px-2 py-1.5 hover:bg-wash">
            <button type="button" className="min-w-0 flex-1 text-left" title="Copy value" onClick={() => navigator.clipboard.writeText(f.value).then(() => toast(`Copied ${f.key}`))}>
              <p className="text-[12.5px] font-medium">{f.key}</p>
              <p className="font-mono text-[11.5px] break-all text-ink-2">{f.value}</p>
              <p className="text-[11.5px] text-ink-3">
                {f.by} · {formatAgo(f.ts, now)}
              </p>
            </button>
            <IconButton
              label={`Clear ${f.key}`}
              className="size-7 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
              onClick={() => setClearing(f.key)}
            >
              <Icon icon={Cancel01Icon} size={14} />
            </IconButton>
          </div>
        ))}
      </section>
      <Alert
        open={clearing !== null}
        onClose={() => setClearing(null)}
        title={`Clear ${clearing ?? "this fact"}?`}
        message="Agents may be relying on it. It’s gone for everyone in the channel, and anyone can set it again."
      >
        <Button variant="secondary" onClick={() => setClearing(null)}>
          Cancel
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => clearing && void clear(clearing)}>
          Clear
        </Button>
      </Alert>
    </div>
  )
}

export function Tasks({ state, now, onOpen, onForgetFact }: { state: ChannelState; now: number; onOpen: (id: number) => void; onForgetFact: (key: string) => Promise<void> }) {
  const [showDone, setShowDone] = useState(false)
  const all = [...state.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)

  if (!all.length && !state.claims.length && !state.facts.size) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-xs">
          <p className="text-[14px] font-semibold">No tasks yet</p>
          <p className="mt-1 text-[13px] leading-normal text-ink-2">When agents split up work with mc task add, each task and who holds it shows up here.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-4 py-6 md:px-8">
        {ORDER.map((s) => {
          const list = all.filter((t) => t.state === s)
          if (!list.length) return null
          const closed = s === "done" || s === "cancelled"
          return (
            <section key={s} className="mb-7">
              <div className="mb-1 flex items-baseline gap-2">
                <h3 className={cx("text-[13px] font-semibold", s === "blocked" ? "text-alert" : "text-ink")}>{LABEL[s]}</h3>
                <span className="text-[12px] text-ink-3 tabular-nums">{list.length}</span>
                {closed && (
                  <button type="button" className="ml-auto text-[12px] font-medium text-ink-2 hover:text-ink" onClick={() => setShowDone((v) => !v)}>
                    {showDone ? "Hide" : "Show"}
                  </button>
                )}
              </div>
              {(!closed || showDone) && list.map((t) => <TaskRow key={t.id} task={t} state={state} now={now} onOpen={() => onOpen(t.id)} />)}
            </section>
          )
        })}
        {!all.length && <p className="mb-7 text-[13px] text-ink-3">No tasks yet.</p>}
        <Board state={state} now={now} onForgetFact={onForgetFact} />
      </div>
    </div>
  )
}

function relatedTo(m: Message, id: number): boolean {
  const ev = m.ev
  if (!ev) return false
  return (ev.op === "task.add" && m.seq === id) || ("task" in ev && ev.task === id)
}

export function TaskDetail({
  id,
  state,
  messages,
  now,
  onClose,
  onOpen,
}: {
  id: number | null
  state: ChannelState
  messages: Message[]
  now: number
  onClose: () => void
  onOpen: (id: number) => void
}) {
  const task = id === null ? undefined : state.tasks.get(id)
  const history = id === null ? [] : messages.filter((m) => relatedTo(m, id) && state.trust.get(m.seq) !== "forged")

  return (
    <Modal open={id !== null} onClose={onClose} wide>
      {task ? (
        <div>
          <header className="flex items-start gap-3 px-6 pt-5">
            <span className="flex pt-1">
              <StateMark state={task.state} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[16px] leading-snug font-semibold tracking-[-0.01em]">{task.title}</h2>
              <p className="mt-0.5 text-[12px] text-ink-2">
                <span className="tabular-nums">{taskId(task.id)}</span>, {LABEL[task.state].toLowerCase()}
              </p>
            </div>
            <IconButton label="Close" onClick={onClose}>
              <Icon icon={Cancel01Icon} size={17} />
            </IconButton>
          </header>

          <dl className="mx-6 mt-4 grid grid-cols-[88px_1fr] gap-y-1.5 border-y border-line py-3 text-[13px]">
            <dt className="text-ink-2">Owner</dt>
            <dd>{task.owner ?? <span className="text-ink-3">Unassigned</span>}</dd>
            <dt className="text-ink-2">Created</dt>
            <dd title={formatFull(task.createdAt)}>
              by {task.createdBy}, {formatAgo(task.createdAt, now)}
            </dd>
            {task.after.length > 0 && (
              <>
                <dt className="text-ink-2">Waits on</dt>
                <dd className="flex flex-wrap gap-x-3">
                  {task.after.map((d) => {
                    const dep = state.tasks.get(d)
                    return (
                      <button key={d} type="button" onClick={() => onOpen(d)} className="text-accent hover:underline">
                        {taskId(d)}
                        {dep ? `, ${LABEL[dep.state].toLowerCase()}` : ""}
                      </button>
                    )
                  })}
                </dd>
              </>
            )}
          </dl>

          {task.detail && (
            <div className="px-6 pt-4 text-[14px] leading-[1.6]">
              <Markdown>{task.detail}</Markdown>
            </div>
          )}

          <div className="px-6 pt-5 pb-6">
            <h3 className="mb-2 text-[12px] font-semibold text-ink-2">History</h3>
            <ol className="grid gap-1.5">
              {history.map((m) => (
                <li key={m.seq} className="flex items-baseline justify-between gap-4 text-[13px]">
                  <span>
                    <span className="font-medium">{m.from}</span> <span className="text-ink-2">{describeEvent(m)}</span>
                  </span>
                  <time className="shrink-0 text-[12px] text-ink-3" title={formatFull(m.ts)}>
                    {formatAgo(m.rts ?? m.ts, now)}
                  </time>
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : (
        <div className="p-6">
          <p className="text-[14px] font-semibold">This task is gone</p>
          <p className="mt-1 text-[13px] text-ink-2">It was pruned from the channel’s history.</p>
        </div>
      )}
    </Modal>
  )
}
