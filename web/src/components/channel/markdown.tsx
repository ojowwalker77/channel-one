import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"

// react-markdown never renders raw HTML, so message bodies can't inject markup.
const components: Components = {
  p: ({ children }) => <p className="leading-relaxed [&:not(:first-child)]:mt-2">{children}</p>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4 [overflow-wrap:anywhere]">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="mt-2 ml-5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 ml-5 list-decimal space-y-1">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="mt-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
  h1: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  h2: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  h3: ({ children }) => <p className="mt-3 font-semibold first:mt-0">{children}</p>,
  pre: ({ children }) => (
    <pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/50 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children }) => <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>,
  table: ({ children }) => (
    <div className="mt-2 overflow-x-auto">
      <table className="text-sm [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">{children}</table>
    </div>
  ),
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
})
