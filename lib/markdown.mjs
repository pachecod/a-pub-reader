// Markdown -> HTML, shared shape with the browser preview.
//
// Drafts store markdown as the canonical format: it is the thing that survives
// round-tripping through a rich-text editor, it diffs cleanly on disk, and it
// maps onto the small tag vocabulary an e-ink reader renders well. The same
// `marked` build runs in the browser for live preview, so what you see there is
// what the EPUB gets.

import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  // Single newlines are wrapping in the editor, not hard breaks.
  breaks: false,
  headerIds: false,
  mangle: false,
});

export function renderMarkdown(md) {
  return marked.parse(String(md ?? ''));
}

/** Plain text of a markdown string, for word counts and empty checks. */
export function markdownText(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
