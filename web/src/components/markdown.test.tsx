import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Markdown } from "./markdown"
import { compareCells, nextSort, sanitizeMarkdownUrl } from "../lib/markdown"

describe("safe markdown links", () => {
  test("allows http, https, mailto and tel only", () => {
    expect(sanitizeMarkdownUrl("https://example.com/a")).toBe("https://example.com/a")
    expect(sanitizeMarkdownUrl("http://example.com")).toBe("http://example.com")
    expect(sanitizeMarkdownUrl("mailto:a@b.example")).toBe("mailto:a@b.example")
    expect(sanitizeMarkdownUrl("tel:+15551212")).toBe("tel:+15551212")
  })

  test("rejects scripts, data, files, relative paths and userinfo", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,hi",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "/channel/facts/ip",
      "//evil.example",
      "https://user:pass@evil.example",
      "https://evil.example/a b",
      "java\nscript:alert(1)",
      "https://evil.example/\t.good.com",
    ]) {
      expect(sanitizeMarkdownUrl(url)).toBeUndefined()
    }
  })

  test("rendered links drop unsafe schemes and do not fetch images", () => {
    const html = renderToStaticMarkup(
      createElement(
        Markdown,
        null,
        "[ok](https://example.com)\n[bad](javascript:alert(1))\n[mail](mailto:a@b.example)\n![pic](https://evil.example/x.png)\n![nope](javascript:alert(1))",
      ),
    )
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain('href="mailto:a@b.example"')
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("<img")
    expect(html).toContain("opens evil.example")
  })
})

describe("markdown tables and code", () => {
  test("sort cycles and compares numbers as numbers", () => {
    expect(nextSort(null, 1)).toEqual({ column: 1, direction: "asc" })
    expect(nextSort({ column: 1, direction: "asc" }, 1)).toEqual({ column: 1, direction: "desc" })
    expect(nextSort({ column: 1, direction: "desc" }, 1)).toBeNull()
    expect(compareCells("10", "2")).toBeGreaterThan(0)
    expect(compareCells("a", "B")).toBeLessThan(0)
  })

  test("a fenced block offers copy and a table header can be sorted", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, null, "```js\nconsole.log(1)\n```\n\n| n | name |\n| - | - |\n| 10 | b |\n| 2 | a |\n"),
    )
    expect(html).toContain('aria-label="Copy code"')
    expect(html).toContain("console.log(1)")
    expect(html).toContain('aria-label="Sort by n"')
    expect(html).toContain('aria-sort="none"')
    expect(html).not.toContain("<script")
  })
})
