/**
 * CDP-based accessibility tree snapshot.
 *
 * Uses Chrome DevTools Protocol `Accessibility.getFullAXTree` to get the
 * accessibility tree directly as structured AXNode objects — bypassing
 * Playwright's ariaSnapshot() which serializes to YAML then we regex-parse.
 *
 * Produces the same ref-annotated YAML format as the Playwright path so the
 * rest of the system (Brain, resolveLocator) works unchanged.
 */

import type { CDPSession } from 'playwright';
import type { ParsedElement } from './snapshot.js';
import { stableHash, INTERACTIVE_ROLES } from './snapshot.js';

/** Shape of a CDP AXNode from Accessibility.getFullAXTree */
interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value: string; sources?: unknown[] };
  value?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface CdpSnapshotResult {
  /** Formatted snapshot (same YAML-like format as ariaSnapshot path) */
  snapshot: string;
  /** Ref map for resolveLocator integration */
  refMap: Map<string, { role: string; name: string; backendNodeId?: number }>;
  /** Parsed elements for diff tracking */
  elements: Map<string, ParsedElement>;
}

/**
 * Build an accessibility tree snapshot via CDP.
 *
 * Calls `Accessibility.getFullAXTree`, reconstructs the tree structure,
 * walks depth-first to produce indented YAML lines with stable ref IDs.
 */
export async function buildCdpSnapshot(cdp: CDPSession): Promise<CdpSnapshotResult> {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };

  if (!nodes || nodes.length === 0) {
    return {
      snapshot: '(empty page)',
      refMap: new Map(),
      elements: new Map(),
    };
  }

  // Build lookup: nodeId -> AXNode
  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  // Find root nodes (nodes without parentId, or first node)
  const rootIds: string[] = [];
  for (const node of nodes) {
    if (!node.parentId) {
      rootIds.push(node.nodeId);
    }
  }
  // Fallback: if no roots found, use first node
  if (rootIds.length === 0 && nodes.length > 0) {
    rootIds.push(nodes[0].nodeId);
  }

  const refMap = new Map<string, { role: string; name: string; backendNodeId?: number }>();
  const elements = new Map<string, ParsedElement>();
  const hashCounts = new Map<string, number>();
  const lines: string[] = [];

  // Structural/invisible roles — skip the node itself but recurse into children
  const SKIP_ROLES = new Set([
    'none', 'generic', 'InlineTextBox', 'LineBreak',
    'StaticText', 'RootWebArea', 'WebArea',
    'paragraph', 'separator', 'presentation', 'figure', 'figcaption',
  ]);

  // Nameless structural containers: skip the node line (nesting noise — the
  // wave-3 serializer port), but recurse into children at the same depth.
  // NAMED containers keep their line: the name is often the data being
  // extracted (scores, counts, row labels).
  const STRUCTURAL_ROLES = new Set([
    'row', 'cell', 'rowgroup', 'table', 'list', 'group',
    'banner', 'navigation', 'main', 'region', 'form', 'article', 'section',
    'complementary', 'contentinfo',
    'LayoutTable', 'LayoutTableRow', 'LayoutTableCell',
  ]);

  // Per-node display-name cap; refMap keeps the full name for resolution.
  const NAME_DISPLAY_CAP = 120;

  // Parent of the text node that produced the last line, to join siblings,
  // and whether a space separates that text from the next sibling.
  let lastTextParent: string | undefined;
  let spaceBefore = false;

  // `named` is the accessible name of the nearest emitted ancestor: text it
  // already carries (a button's label, a link's text) is not repeated.
  function walk(nodeId: string, depth: number, named = ''): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    // Ignored nodes: still recurse into children (Chrome marks structural
    // nodes like <html>/<body> as ignored while their children are not)
    if (node.ignored) {
      if (node.childIds) {
        for (const childId of node.childIds) {
          walk(childId, depth, named);
        }
      }
      return;
    }

    const role = node.role?.value;

    // Visible text the page shows outside any named element: a to-do's
    // label, a cart line's price, an order total. Without it the model
    // cannot tell repeated controls apart ("Toggle Todo" x3) and the goal
    // verifier cannot read the values a goal names. Adjacent text nodes
    // render as one string ("Item total: $" + "39.98"), so they share a line.
    if (role === 'StaticText') {
      const raw = (node.name?.value || '').replace(/\s+/g, ' ');
      const text = raw.trim();
      if (!text) {
        if (raw) spaceBefore = true;
        return;
      }
      const prefix = `${'  '.repeat(depth)}- text: `;
      const joins = !!node.parentId && lastTextParent === node.parentId && !!lines[lines.length - 1]?.startsWith(prefix);
      lastTextParent = undefined;
      if (named.includes(text)) return;
      const shown = text.length > NAME_DISPLAY_CAP ? `${text.slice(0, NAME_DISPLAY_CAP - 1)}…` : text;
      if (joins) lines[lines.length - 1] += `${spaceBefore || raw.startsWith(' ') ? ' ' : ''}${shown}`;
      else lines.push(`${prefix}${shown}`);
      lastTextParent = node.parentId;
      spaceBefore = raw.endsWith(' ');
      return;
    }
    lastTextParent = undefined;

    if (!role || SKIP_ROLES.has(role)) {
      // No role or structural role — recurse into children at same depth
      if (node.childIds) {
        for (const childId of node.childIds) {
          walk(childId, depth, named);
        }
      }
      return;
    }

    const name = node.name?.value || '';
    const value = node.value?.value;
    const indent = '  '.repeat(depth);

    // Chrome date/time control: expose ONE ref'd fillable element and drop
    // the shadow-DOM subtree entirely (its spinbuttons carry unresolvable
    // doubled names — the wave-2/3 form-fill date loop). resolveLocator
    // special-cases role 'Date' to getByLabel; fill('YYYY-MM-DD') works
    // natively on input[type=date].
    if (role === 'Date' || role === 'time') {
      const baseHash = stableHash(role, name);
      const count = hashCounts.get(baseHash) || 0;
      hashCounts.set(baseHash, count + 1);
      const refId = count === 0 ? baseHash : `${baseHash}_${count}`;
      refMap.set(refId, { role: 'Date', name, backendNodeId: node.backendDOMNodeId });
      elements.set(refId, { ref: refId, role: 'Date', name, value });
      lines.push(`${indent}- date "${name}" [ref=${refId}] (date input — fill with YYYY-MM-DD)`);
      return; // no recursion — shadow parts dropped
    }

    // Nameless structural wrappers and decorative images: skip the line,
    // keep the children at the same depth.
    if (!name && (STRUCTURAL_ROLES.has(role) || role === 'image' || role === 'img')) {
      if (node.childIds) {
        for (const childId of node.childIds) {
          walk(childId, depth, named);
        }
      }
      return;
    }

    // Determine if this element gets a ref
    const needsRef = INTERACTIVE_ROLES.has(role) || role === 'heading' || role === 'dialog' || role === 'alertdialog';

    let refStr = '';
    if (needsRef) {
      const baseHash = stableHash(role, name);
      const count = hashCounts.get(baseHash) || 0;
      hashCounts.set(baseHash, count + 1);
      const refId = count === 0 ? baseHash : `${baseHash}_${count}`;

      refMap.set(refId, { role, name, backendNodeId: node.backendDOMNodeId });
      elements.set(refId, { ref: refId, role, name, value });
      refStr = ` [ref=${refId}]`;
    }

    const displayName = name.length > NAME_DISPLAY_CAP ? `${name.slice(0, NAME_DISPLAY_CAP - 1)}…` : name;
    const nameStr = displayName ? ` "${displayName}"` : '';
    const valueStr = value !== undefined ? ` [value="${value}"]` : '';
    const checked = node.properties?.find((p) => p.name === 'checked')?.value.value;
    const checkedStr = checked === 'true' || checked === true ? ' [checked]' : checked === 'mixed' ? ' [checked=mixed]' : '';

    // Check if node has visible children (not just StaticText/InlineTextBox)
    const hasVisibleChildren = node.childIds?.some((cid) => {
      const child = nodeMap.get(cid);
      if (!child) return false;
      if (child.ignored) return child.childIds?.length ? true : false;
      const cRole = child.role?.value;
      return cRole && !SKIP_ROLES.has(cRole);
    }) ?? false;
    const colon = hasVisibleChildren ? ':' : '';

    lines.push(`${indent}- ${role}${nameStr}${refStr}${valueStr}${checkedStr}${colon}`);

    if (node.childIds) {
      for (const childId of node.childIds) {
        walk(childId, depth + 1, name || named);
      }
    }
  }

  for (const rootId of rootIds) {
    walk(rootId, 0);
  }

  return {
    snapshot: lines.length > 0 ? lines.join('\n') : '(empty page)',
    refMap,
    elements,
  };
}
