import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { compareCells, nextSort, sanitizeMarkdownUrl, type SortDir } from "../lib/markdown"
import { Icon } from "./icon"

// react-markdown never renders raw HTML. urlTransform also drops any scheme outside the allowlist.
const components: Components = {
  p: ({ children }) => <p className="[&:not(:first-child)]:mt-2">{children}</p>,
  // Links in messages only ever open elsewhere: never an in-app address (those can carry keys).
  a: ({ children, href }) => {
    const safe = typeof href === "string" ? sanitizeMarkdownUrl(href) : undefined
    if (!safe) return <span className="underline decoration-dotted underline-offset-2">{children}</span>
    if (/^https?:\/\//i.test(safe)) {
      return (
        <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className="[overflow-wrap:anywhere] text-link underline decoration-link/30 underline-offset-2 hover:decoration-link">
          {children}
        </a>
      )
    }
    return (
      <a href={safe} className="[overflow-wrap:anywhere] text-link underline decoration-link/30 underline-offset-2 hover:decoration-link">
        {children}
      </a>
    )
  },
  // Remote images would tell their host who read the message, and when: show a link instead.
  img: ({ src, alt }) =>
    typeof src === "string" && sanitizeMarkdownUrl(src) && /^https?:\/\//i.test(src) ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline decoration-link/30 underline-offset-2">
        {alt || "image"} (opens {new URL(src).hostname})
      </a>
    ) : (
      <span>{alt || ""}</span>
    ),
  ul: ({ children }) => <ul className="mt-1.5 ml-5 list-disc space-y-0.5 marker:text-ink-3">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1.5 ml-5 list-decimal space-y-0.5 marker:text-ink-3">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="mt-2 border-l-2 border-line pl-3 text-ink-2">{children}</blockquote>,
  h1: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  h2: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  h3: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children }) => <code className="rounded-[4px] bg-wash-2 px-1 py-px font-mono text-[0.86em]">{children}</code>,
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <div className="group relative my-2">
      <pre ref={preRef} className="overflow-x-auto rounded-[8px] bg-wash px-3 py-2.5 font-mono text-[12.5px] leading-relaxed shadow-[inset_0_0_0_0.5px_var(--line)] [&>code]:bg-transparent [&>code]:p-0">
        {children}
      </pre>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy code"}
        className="absolute top-1.5 right-1.5 inline-flex size-7 items-center justify-center rounded-[7px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-wash-2 hover:text-ink"
        onClick={() => {
          const text = preRef.current?.innerText ?? ""
          if (!text || !navigator.clipboard) return
          navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true)
              window.clearTimeout(timer.current)
              timer.current = window.setTimeout(() => setCopied(false), 1500)
            })
            .catch(() => {})
        }}
      >
        <Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
      </button>
    </div>
  )
}

type Sort = { column: number; direction: SortDir } | null

function MarkdownTable({ children }: { children?: ReactNode }) {
  const { headers, rows } = useMemo(() => extractTable(children), [children])
  const [sort, setSort] = useState<Sort>(null)
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort])
  if (headers.length === 0) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="text-[13px]">{children}</table>
      </div>
    )
  }
  return (
    <div className="my-2 overflow-x-auto">
      <table className="text-[13px] [&_td]:border-b [&_td]:border-line [&_td]:py-1 [&_td]:pr-4 [&_th]:border-b [&_th]:border-line [&_th]:py-1 [&_th]:pr-4 [&_th]:text-left [&_th]:font-semibold">
        <thead>
          <tr>
            {headers.map((header, index) => {
              const direction = sort?.column === index ? sort.direction : null
              const label = cellText(header) || `column ${index + 1}`
              return (
                <th key={index} scope="col" aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}>
                  <button type="button" className="inline-flex items-center gap-1 text-left font-semibold hover:text-ink focus-visible:[outline-offset:-2px]" aria-label={`Sort by ${label}`} onClick={() => setSort((current) => nextSort(current, index))}>
                    {header}
                    <span aria-hidden className="text-[10px] text-ink-3">
                      {direction === "asc" ? "↑" : direction === "desc" ? "↓" : ""}
                    </span>
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {headers.map((_, columnIndex) => (
                <td key={columnIndex}>{row[columnIndex] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function sortRows(rows: ReactNode[][], sort: Sort): ReactNode[][] {
  if (!sort) return rows
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const compared = compareCells(cellText(a.row[sort.column]), cellText(b.row[sort.column]))
      if (compared === 0) return a.index - b.index
      return sort.direction === "asc" ? compared : -compared
    })
    .map((item) => item.row)
}

function extractTable(children: ReactNode): { headers: ReactNode[]; rows: ReactNode[][] } {
  const headers: ReactNode[] = []
  const rows: ReactNode[][] = []
  const walk = (node: ReactNode) => {
    for (const child of Children.toArray(node)) {
      if (!isCellElement(child)) continue
      if (child.type === "tr") {
        const th = cells(child, "th")
        const td = cells(child, "td")
        if (th.length > 0 && headers.length === 0) headers.push(...th)
        else if (td.length > 0) rows.push(td)
      } else walk(child.props.children)
    }
  }
  walk(children)
  return { headers, rows }
}

function cells(row: ReactElement<{ children?: ReactNode }>, type: "th" | "td"): ReactNode[] {
  return Children.toArray(row.props.children)
    .filter((cell): cell is ReactElement<{ children?: ReactNode }> => isCellElement(cell) && cell.type === type)
    .map((cell) => cell.props.children)
}

function isCellElement(node: ReactNode): node is ReactElement<{ children?: ReactNode }> {
  return isValidElement<{ children?: ReactNode }>(node)
}

function cellText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(cellText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return cellText(node.props.children)
  return ""
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="[overflow-wrap:anywhere] break-words">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
        urlTransform={(url) => sanitizeMarkdownUrl(url) ?? ""}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})
