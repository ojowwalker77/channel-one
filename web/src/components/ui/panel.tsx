import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"

import { cx } from "@/lib/utils"

// A side panel you can widen by dragging its left edge (or with the arrow keys
// on that edge). Its width is kept per browser. On phones it fills the screen.

const KEY = "mc.panel.width"
const MIN = 300
const DEFAULT = 360
const MAX = 720
/** The conversation never gets narrower than this while the panel grows. */
const MIN_CHAT = 420

const clamp = (w: number) => Math.round(Math.max(MIN, Math.min(MAX, Math.min(w, window.innerWidth - MIN_CHAT))))

function stored(): number {
  const v = Number(localStorage.getItem(KEY))
  return v >= MIN ? v : DEFAULT
}

export function ResizablePanel({ children, className }: { children: ReactNode; className?: string }) {
  const [width, setWidth] = useState(stored)
  const [dragging, setDragging] = useState(false)
  const from = useRef<{ x: number; width: number } | null>(null)
  const shown = typeof window === "undefined" ? width : clamp(width)

  useEffect(() => localStorage.setItem(KEY, String(width)), [width])

  return (
    <div className={cx("relative h-full w-full shrink-0 md:w-(--panel)", dragging && "select-none", className)} style={{ "--panel": `${shown}px` } as CSSProperties}>
      <hr
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={shown}
        className={cx(
          "absolute inset-y-0 -left-1 z-10 m-0 hidden w-2 cursor-col-resize touch-none border-0 bg-transparent transition-colors outline-none md:block",
          "after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent hover:after:bg-line focus-visible:after:bg-ring",
          dragging && "after:bg-ring"
        )}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          from.current = { x: e.clientX, width: shown }
          setDragging(true)
        }}
        onPointerMove={(e) => from.current && setWidth(clamp(from.current.width + from.current.x - e.clientX))}
        onPointerUp={() => ((from.current = null), setDragging(false))}
        onPointerCancel={() => ((from.current = null), setDragging(false))}
        onDoubleClick={() => setWidth(DEFAULT)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault()
            setWidth(clamp(shown + (e.key === "ArrowLeft" ? 32 : -32)))
          } else if (e.key === "Home") setWidth(MIN)
          else if (e.key === "End") setWidth(clamp(MAX))
        }}
      />
      {children}
    </div>
  )
}
