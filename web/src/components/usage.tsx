import type { ChannelRow } from "@/lib/channel"
import { formatBytes, type MyUsage } from "@/lib/usage"
import { cx } from "@/lib/utils"
import { Button, Modal } from "./kit"

/** A relay's reason, with any address in it (a waitlist, say) made into a link. */
export function Reason({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+[^\s).,;])/)
  return (
    <p className={cx("text-[13px] leading-normal", className)}>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </p>
  )
}

/** "1 of 2 channels": the sidebar's small reminder of the one limit that stops you creating. */
export function usageLine(u: MyUsage): string | null {
  const most = u.limits.channelsPerOwner
  return most === null ? null : `${u.owned} of ${most} channel${most === 1 ? "" : "s"}`
}

function Meter({ label, used, most, show = String }: { label: string; used: number; most: number | null; show?: (n: number) => string }) {
  const full = most !== null && used >= most
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
      <span className="text-ink-2">{label}</span>
      <span className={cx("tabular-nums", full ? "font-medium text-alert" : "text-ink")}>
        {show(used)}
        {most !== null && <span className="text-ink-3"> / {show(most)}</span>}
      </span>
    </div>
  )
}

/** What each channel you own uses of this relay's limits. */
export function UsageModal({ open, onClose, usage, rows }: { open: boolean; onClose: () => void; usage: MyUsage | null; rows: ChannelRow[] }) {
  const title = (room: string) => rows.find((r) => r.room === room)?.title ?? `Channel ${room.slice(0, 4).toUpperCase()}`
  const l = usage?.limits
  return (
    <Modal open={open} onClose={onClose}>
      <div className="p-5">
        <h2 className="text-[15px] font-semibold">Usage</h2>
        {usage && l ? (
          <>
            <p className="mt-1 text-[13px] leading-normal text-ink-2">
              {l.channelsPerOwner === null ? `You own ${usage.owned} channel${usage.owned === 1 ? "" : "s"}.` : `You own ${usage.owned} of the ${l.channelsPerOwner} channels you can have here.`}
              {l.messagesPerDay !== null && " Daily message counts reset at 00:00 UTC."}
              {l.expireAfterDays !== null && ` A channel with no messages and nobody connected for ${l.expireAfterDays} days is deleted.`}
            </p>
            <div className="mt-4 grid gap-3">
              {usage.channels.length === 0 && <p className="text-[13px] text-ink-3">You don’t own any channels yet.</p>}
              {usage.channels.map((c) => (
                <div key={c.room} className="grid gap-1 rounded-[8px] p-3 shadow-[inset_0_0_0_1px_var(--line)]">
                  <p className="truncate text-[13.5px] font-medium">{title(c.room)}</p>
                  <Meter label="Messages today" used={c.messagesToday} most={l.messagesPerDay} />
                  <Meter label="Stored" used={c.bytes} most={l.bytesPerChannel} show={formatBytes} />
                  <Meter label="Members" used={c.members} most={l.membersPerChannel} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="mt-1 text-[13px] text-ink-2">This relay doesn’t report usage.</p>
        )}
        <div className="mt-5 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}
