import type { ReactNode } from "react";

/**
 * Renders plain text where [Label](https://example.com) becomes a clickable link.
 * Used for the admin-editable texts of the registration form. Only http(s)
 * links are turned into anchors; everything else stays text. Line breaks are
 * preserved by the parent via `whitespace-pre-line`.
 */
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export default function LinkedText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <a key={key++} href={m[2]} target="_blank" rel="noopener noreferrer" className="font-medium text-[#201E1B] underline">
        {m[1]}
      </a>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}
