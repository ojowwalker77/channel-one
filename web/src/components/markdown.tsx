import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"

// react-markdown never renders raw HTML, so message bodies can't inject markup.
function components(link: string): Components {
  return {
    p: ({ children }) => <p className="[&:not(:first-child)]:mt-1.5">{children}</p>,
    a: ({ children, href }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className={`${link} underline underline-offset-2 [overflow-wrap:anywhere]`}>
        {children}
      </a>
    ),
    ul: ({ children }) => <ul className="mt-1.5 ml-5 list-disc space-y-0.5">{children}</ul>,
    ol: ({ children }) => <ol className="mt-1.5 ml-5 list-decimal space-y-0.5">{children}</ol>,
    blockquote: ({ children }) => <blockquote className="mt-1.5 border-l-2 border-current/30 pl-2.5 opacity-80">{children}</blockquote>,
    h1: ({ children }) => <p className="mt-2 font-semibold first:mt-0">{children}</p>,
    h2: ({ children }) => <p className="mt-2 font-semibold first:mt-0">{children}</p>,
    h3: ({ children }) => <p className="mt-2 font-semibold first:mt-0">{children}</p>,
    pre: ({ children }) => (
      <pre className="my-1.5 overflow-x-auto rounded-lg bg-current/10 px-2.5 py-2 font-mono text-[12.5px] leading-relaxed [&>code]:bg-transparent [&>code]:p-0">
        {children}
      </pre>
    ),
    code: ({ children }) => <code className="rounded bg-current/10 px-1 py-px font-mono text-[0.88em]">{children}</code>,
    hr: () => <hr className="my-2 border-current/20" />,
    table: ({ children }) => (
      <div className="my-1.5 overflow-x-auto">
        <table className="text-[13px] [&_td]:border [&_td]:border-current/20 [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_th]:border-current/20 [&_th]:px-2 [&_th]:py-0.5 [&_th]:text-left">
          {children}
        </table>
      </div>
    ),
  }
}

const ON_BLUE = components("text-inherit")
const ON_GRAY = components("text-blue")

export const Markdown = memo(function Markdown({ children, onBlue }: { children: string; onBlue?: boolean }) {
  return (
    <div className="break-words [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={onBlue ? ON_BLUE : ON_GRAY}>
        {children}
      </ReactMarkdown>
    </div>
  )
})
