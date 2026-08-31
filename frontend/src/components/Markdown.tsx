import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

/**
 * Assistant prose, rendered.
 *
 * The model writes markdown whether or not anything renders it -- headings for
 * each goal, bold for the numbers, backticks around field names like
 * `total_units_source`. Shown raw, the asterisks and hashes compete with the
 * figures they were meant to emphasise.
 *
 * Every element is mapped onto the design system's tokens rather than left to
 * browser defaults, because the defaults bring their own type scale and would
 * read as a foreign document dropped into the card. Nothing here introduces a
 * size the system does not already have.
 *
 * react-markdown builds React elements and never sets innerHTML, and raw HTML
 * in the source is ignored unless a plugin opts in. That matters: this text is
 * model-generated from user data, so it is not a trusted string.
 */

const components: Components = {
  // The assistant's headings are section markers inside a card, not page
  // titles. They step up from body only enough to separate.
  h1: ({ children }) => (
    <div className="mt-4 text-body font-medium text-ink first:mt-0">{children}</div>
  ),
  h2: ({ children }) => (
    <div className="mt-4 text-body font-medium text-ink first:mt-0">{children}</div>
  ),
  h3: ({ children }) => (
    <div className="mt-4 text-body-sm font-medium text-ink first:mt-0">{children}</div>
  ),
  h4: ({ children }) => (
    <div className="mt-3 text-body-sm font-medium text-ink first:mt-0">{children}</div>
  ),

  p: ({ children }) => <p className="mt-2 leading-relaxed first:mt-0">{children}</p>,

  ul: ({ children }) => (
    <ul className="mt-2 list-disc space-y-1 pl-5 marker:text-faint first:mt-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-2 list-decimal space-y-1 pl-5 marker:text-faint first:mt-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

  // Bold is where the numbers live, so it gets the brightest ink in the scale.
  strong: ({ children }) => <strong className="font-medium text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,

  // Field names and identifiers. Mono at a size that sits on the body baseline
  // instead of pushing the line height around.
  code: ({ children }) => (
    <code className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em] text-ink">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mt-2 overflow-x-auto rounded-control bg-abyss p-3 font-mono text-caption first:mt-0">
      {children}
    </pre>
  ),

  a: ({ children, href }) => (
    <a href={href} className="text-iris underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mt-2 border-l-2 border-line pl-3 text-muted first:mt-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,

  // Wide tables scroll inside the card rather than stretching it.
  table: ({ children }) => (
    <div className="mt-2 overflow-x-auto first:mt-0">
      <table className="w-full border-collapse text-caption">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line px-2 py-1 text-left font-medium text-muted">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-b border-line px-2 py-1">{children}</td>,
};

export function Markdown({ children }: { children: string }) {
  return <ReactMarkdown components={components}>{children}</ReactMarkdown>;
}
