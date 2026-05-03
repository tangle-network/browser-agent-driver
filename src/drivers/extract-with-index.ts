/**
 * extractWithIndex implementation.
 *
 * Runs in page context via page.evaluate() and returns a numbered list of
 * every visible element matching `query`, each with its tag, textContent,
 * key attributes, and a stable selector. The agent picks elements by index
 * in the next turn.
 *
 * The model emits a broad query and reads the actual text content of every
 * match, which is more reliable than precise selectors for pages where data
 * lives in obscure wrappers or `<dl>/<dt>/<dd>` blocks.
 */

import type { Page } from 'playwright';

export interface ExtractMatch {
  /** Position in the result list (0-based) */
  index: number;
  /** Element tag name (lowercase) */
  tag: string;
  /** Visible text content, trimmed and length-capped */
  text: string;
  /** Key attributes that help uniquely identify the element */
  attributes: Record<string, string>;
  /** A stable CSS selector the agent can use in a follow-up action */
  selector: string;
}

/** Hard cap on matches returned per call. Prevents 800-element pages from blowing the response. */
const MAX_MATCHES = 80;
/** Per-element textContent cap. */
const TEXT_CAP = 200;

/**
 * Execute the extractWithIndex action in page context. The function passed
 * to page.evaluate runs in the browser; it must be self-contained (no
 * closures over Node-side variables).
 */
export async function runExtractWithIndex(
  page: Page,
  query: string,
  contains?: string,
): Promise<ExtractMatch[]> {
  return await page.evaluate(
    ({ query, contains, max, textCap }) => {
      // Browser-side helpers (must be self-contained)
      const isVisible = (el: Element): boolean => {
        if (!(el instanceof HTMLElement)) return true;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const cssEscape = (s: string): string =>
        (window.CSS && typeof window.CSS.escape === 'function')
          ? window.CSS.escape(s)
          : s.replace(/[^\w-]/g, (c) => `\\${c}`);

      // Build a selector that uniquely targets the element. Preference order:
      //   [data-testid="x"] > [id="x"] > [aria-label="x"] > tag.cls.cls > nth-of-type
      const buildSelector = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const testid = el.getAttribute('data-testid');
        if (testid) return `[data-testid="${testid}"]`;
        const id = el.getAttribute('id');
        if (id && /^[a-zA-Z][\w-]*$/.test(id)) return `#${id}`;
        const aria = el.getAttribute('aria-label');
        if (aria && aria.length < 60) return `${tag}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
        // Class-based fallback (cap at 3 stable-looking classes)
        const classes = (el.className && typeof el.className === 'string')
          ? el.className.split(/\s+/).filter((c) =>
              c.length > 0 && c.length < 40 && /^[a-zA-Z_-][\w-]*$/.test(c) && !/^\d/.test(c),
            ).slice(0, 3)
          : [];
        if (classes.length > 0) return `${tag}.${classes.map(cssEscape).join('.')}`;
        // Last resort: tag + nth-of-type position relative to parent
        const parent = el.parentElement;
        if (!parent) return tag;
        const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        const idx = siblings.indexOf(el) + 1;
        return `${tag}:nth-of-type(${idx})`;
      };

      // Collect interesting attributes for each match (helps the LLM
      // disambiguate without bloating the response)
      const attrsForMatch = (el: Element): Record<string, string> => {
        const attrs: Record<string, string> = {};
        const interesting = ['id', 'data-testid', 'aria-label', 'role', 'href', 'name', 'type', 'value'];
        for (const name of interesting) {
          const v = el.getAttribute(name);
          if (v != null && v.length > 0 && v.length < 200) attrs[name] = v;
        }
        return attrs;
      };

      let elements: Element[];
      try {
        elements = Array.from(document.querySelectorAll(query));
      } catch {
        // Invalid selector — return empty so the runner can report the error cleanly.
        return [];
      }

      const filterText = contains ? contains.toLowerCase() : '';
      const matches: ExtractMatch[] = [];

      for (const el of elements) {
        if (!isVisible(el)) continue;
        const rawText = (el.textContent || '').trim().replace(/\s+/g, ' ');
        if (filterText && !rawText.toLowerCase().includes(filterText)) continue;
        const text = rawText.length > textCap ? rawText.slice(0, textCap) + '…' : rawText;
        // Skip empty text matches unless the element has interesting attributes
        if (!text && Object.keys(attrsForMatch(el)).length === 0) continue;
        matches.push({
          index: matches.length,
          tag: el.tagName.toLowerCase(),
          text,
          attributes: attrsForMatch(el),
          selector: buildSelector(el),
        });
        if (matches.length >= max) break;
      }

      return matches;
    },
    { query, contains: contains ?? '', max: MAX_MATCHES, textCap: TEXT_CAP },
  );
}

/**
 * Format extract matches as a compact, LLM-readable list. The format is
 * line-per-match with index, tag, attributes, then text on the next line.
 *
 *   [0] p {class: "downloads"}
 *       Weekly downloads: 26,543,821
 *   [1] dd
 *       Returns a new array formed by applying...
 */
export function formatExtractWithIndexResult(
  matches: ExtractMatch[],
  query: string,
  contains?: string,
): string {
  if (matches.length === 0) {
    return `(no matches for query "${query}"${contains ? ` containing "${contains}"` : ''})`;
  }
  const lines: string[] = [];
  for (const m of matches) {
    const attrPairs = Object.entries(m.attributes)
      .map(([k, v]) => `${k}="${v.length > 60 ? v.slice(0, 60) + '…' : v}"`)
      .join(' ');
    const attrPart = attrPairs ? ` ${attrPairs}` : '';
    lines.push(`[${m.index}] <${m.tag}>${attrPart}  selector: ${m.selector}`);
    if (m.text) {
      lines.push(`    text: ${m.text}`);
    }
  }
  if (matches.length === MAX_MATCHES) {
    lines.push(`(capped at ${MAX_MATCHES} matches — narrow your query or use a 'contains' filter to see more)`);
  }
  return lines.join('\n');
}
