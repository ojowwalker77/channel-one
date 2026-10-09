import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { useLayoutEffect, useRef, type ReactNode } from "react"

import { Icon } from "./icon"
import { IconButton } from "./kit"
import { ResizablePanel } from "./ui/panel"

// A thread on the right: the message it started from, every reply under it,
// and a composer that answers in the thread. The main timeline keeps only
// the first message and a "N replies" line.

export function ThreadPanel({ count, children, composer, onClose }: { count: number; children: ReactNode; composer: ReactNode; onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null)
  // Open at the latest reply, and follow new ones as they come in.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count])

  return (
    <ResizablePanel>
      <aside className="animate-slide-in flex h-full w-full flex-col bg-canvas shadow-[inset_0.5px_0_0_var(--line)]">
        <header className="flex h-[56px] shrink-0 items-center justify-between pr-3 pl-5 shadow-[inset_0_-0.5px_0_var(--line)]">
          <span className="text-[13px] font-semibold">
            Thread <span className="font-normal text-ink-3">{count === 1 ? "1 reply" : `${count} replies`}</span>
          </span>
          <IconButton label="Close thread" onClick={onClose}>
            <Icon icon={Cancel01Icon} size={17} />
          </IconButton>
        </header>
        <div ref={scroller} className="flex-1 overflow-y-auto">
          <div className="px-4 pb-4 md:px-5">{children}</div>
        </div>
        {composer}
      </aside>
    </ResizablePanel>
  )
}
