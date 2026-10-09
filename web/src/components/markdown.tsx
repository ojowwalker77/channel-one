import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"

// react-markdown never renders raw HTML, so message bodies can't inject markup.
const components: Components = {
  p: ({ children }) => <p className="[&:not(:first-child)]:mt-2">{children}</p>,
  // Links in messages only ever open elsewhere: never an in-app address (those can carry keys).
  a: ({ children, href }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="[overflow-wrap:anywhere] text-link underline decoration-link/30 underline-offset-2 hover:decoration-link">
        {children}
      </a>
    ) : (
      <span className="underline decoration-dotted underline-offset-2">{children}</span>
    ),
  // Remote images would tell their host who read the message, and when: show a link instead.
  img: ({ src, alt }) =>
    typeof src === "string" && /^https?:\/\//i.test(src) ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline decoration-link/30 underline-offset-2">
        {alt || "image"} (opens {new URL(src).hostname})
      </a>
    ) : null,
  ul: ({ children }) => <ul className="mt-1.5 ml-5 list-disc space-y-0.5 marker:text-ink-3">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1.5 ml-5 list-decimal space-y-0.5 marker:text-ink-3">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="mt-2 border-l-2 border-line pl-3 text-ink-2">{children}</blockquote>,
  h1: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  h2: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  h3: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-[8px] bg-wash px-3 py-2.5 font-mono text-[12.5px] leading-relaxed shadow-[inset_0_0_0_0.5px_var(--line)] [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="rounded-[4px] bg-wash-2 px-1 py-px font-mono text-[0.86em]">{children}</code>,
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="text-[13px] [&_td]:border-b [&_td]:border-line [&_td]:py-1 [&_td]:pr-4 [&_th]:border-b [&_th]:border-line [&_th]:py-1 [&_th]:pr-4 [&_th]:text-left [&_th]:font-semibold">
        {children}
      </table>
    </div>
  ),
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="[overflow-wrap:anywhere] break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
})
