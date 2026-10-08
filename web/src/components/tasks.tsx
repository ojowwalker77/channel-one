import { CheckIcon, XIcon } from "lucide-react"
import { useState } from "react"

import { describeEvent } from "@mc/format.ts"
import type { Message, TaskState } from "@mc/protocol.ts"
import { taskId, waitingOn, type ChannelState, type Task } from "@mc/state.ts"
import { formatAgo, formatFull } from "@/lib/format"
import { cx } from "@/lib/utils"
import { IconButton, Modal } from "./kit"
import { Markdown } from "./markdown"

const STATES: Record<TaskState, { label: string; color: string }> = {
  doing: { label: "In Progress", color: "var(--blue)" },
  blocked: { label: "Blocked", color: "var(--red)" },
  review: { label: "In Review", color: "var(--orange)" },
  todo: { label: "To Do", color: "var(--label-3)" },
  done: { label: "Done", color: "var(--green)" },
}
const ORDER: TaskState[] = ["doing", "blocked", "review", "todo", "done"]

/** The Reminders-style ring: hollow while open, filled with a check when done. */
function Ring({ state }: { state: TaskState }) {
  const color = STATES[state].color
  if (state === "done") {
    return (
      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full" style={{ background: color }}>
        <CheckIcon className="size-3.5 text-white" strokeWidth={3} />
      </span>
    )
  }
  return (
    <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px]" style={{ borderColor: color }}>
      {state !== "todo" && <span className="size-2.5 rounded-full" style={{ background: color }} />}
    </span>
  )
}

function TaskRow({ task, state, now, onOpen }: { task: Task; state: ChannelState; now: number; onOpen: () => void }) {
  const waits = waitingOn(state, task)
  return (
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 rounded-lg pl-4 text-left transition hover:bg-fill-2">
      <span className="pt-[11px]">
        <Ring state={task.state} />
      </span>
      <span className="min-w-0 flex-1 border-b border-separator py-2.5 pr-4">
        <span className={cx("block text-[15px] leading-snug", task.state === "done" && "text-label-2")}>{task.title}</span>
        <span className="mt-0.5 block truncate text-[12px] text-label-2">
          {taskId(task.id)}
          {task.owner ? ` · ${task.owner}` : " · unassigned"}
          {waits.length ? ` · after ${waits.map(taskId).join(", ")}` : ""}
          {task.notes.length ? ` · ${task.notes.length} ${task.notes.length === 1 ? "note" : "notes"}` : ""} · {formatAgo(task.updatedAt, now)}
        </span>
      </span>
    </button>
  )
}

export function Tasks({ state, now, onOpen }: { state: ChannelState; now: number; onOpen: (id: number) => void }) {
  const [showDone, setShowDone] = useState(false)
  const all = [...state.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)

  if (!all.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
        <p className="text-[17px] font-semibold">No Tasks</p>
        <p className="max-w-xs text-[13px] text-label-2">When agents split up work with `mc task add`, it shows up here.</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-2 py-4 md:px-6">
        {ORDER.map((s) => {
          const list = all.filter((t) => t.state === s)
          if (!list.length) return null
          const done = s === "done"
          return (
            <section key={s} className="mb-6">
              <div className="flex items-baseline justify-between px-4 pb-1">
                <h3 className="text-[20px] font-bold" style={{ color: STATES[s].color === "var(--label-3)" ? "var(--label)" : STATES[s].color }}>
                  {STATES[s].label}
                </h3>
                {done ? (
                  <button type="button" className="text-[13px] text-blue" onClick={() => setShowDone((v) => !v)}>
                    {showDone ? "Hide" : `Show ${list.length}`}
                  </button>
                ) : (
                  <span className="text-[13px] text-label-2">{list.length}</span>
                )}
              </div>
              {(!done || showDone) && list.map((t) => <TaskRow key={t.id} task={t} state={state} now={now} onOpen={() => onOpen(t.id)} />)}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function relatedTo(m: Message, id: number): boolean {
  const ev = m.ev
  if (!ev) return false
  return (ev.op === "task.add" && m.seq === id) || ("task" in ev && ev.task === id)
}

export function TaskDetail({ id, state, messages, now, onClose, onOpen }: { id: number | null; state: ChannelState; messages: Message[]; now: number; onClose: () => void; onOpen: (id: number) => void }) {
  const task = id === null ? undefined : state.tasks.get(id)
  const history = id === null ? [] : messages.filter((m) => relatedTo(m, id) && state.trust.get(m.seq) !== "forged")

  return (
    <Modal open={id !== null} onClose={onClose} wide>
      {task ? (
        <div className="flex flex-col">
          <header className="flex items-start gap-3 px-5 pt-5">
            <span className="pt-0.5">
              <Ring state={task.state} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] leading-snug font-semibold">{task.title}</h2>
              <p className="mt-0.5 text-[12px] text-label-2">
                {taskId(task.id)} · <span style={{ color: STATES[task.state].color === "var(--label-3)" ? undefined : STATES[task.state].color }}>{STATES[task.state].label}</span>
              </p>
            </div>
            <IconButton label="Close" onClick={onClose}>
              <XIcon />
            </IconButton>
          </header>

          <dl className="mx-5 mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-xl bg-fill-2 px-4 py-3 text-[13px]">
            <dt className="text-label-2">Owner</dt>
            <dd>{task.owner ?? <span className="text-label-2">Unassigned</span>}</dd>
            <dt className="text-label-2">Created</dt>
            <dd title={formatFull(task.createdAt)}>
              by {task.createdBy}, {formatAgo(task.createdAt, now)}
            </dd>
            {task.after.length > 0 && (
              <>
                <dt className="text-label-2">After</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {task.after.map((d) => {
                    const dep = state.tasks.get(d)
                    return (
                      <button key={d} type="button" onClick={() => onOpen(d)} className="text-blue hover:underline">
                        {taskId(d)}
                        {dep ? ` (${STATES[dep.state].label.toLowerCase()})` : ""}
                      </button>
                    )
                  })}
                </dd>
              </>
            )}
          </dl>

          {task.detail && (
            <div className="px-5 pt-4 text-[14px]">
              <Markdown>{task.detail}</Markdown>
            </div>
          )}

          <div className="px-5 pt-5 pb-5">
            <h3 className="mb-2 text-[13px] text-label-2">History</h3>
            <ol className="grid gap-2">
              {history.map((m) => (
                <li key={m.seq} className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span>
                    <span className="font-medium">{m.from}</span> <span className="text-label-2">{describeEvent(m)}</span>
                  </span>
                  <time className="shrink-0 text-[12px] text-label-3" title={formatFull(m.ts)}>
                    {formatAgo(m.rts ?? m.ts, now)}
                  </time>
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : (
        <div className="p-6 text-center">
          <p className="text-[17px] font-semibold">Task not found</p>
          <p className="mt-1 text-[13px] text-label-2">It may have been pruned from the channel history.</p>
        </div>
      )}
    </Modal>
  )
}
