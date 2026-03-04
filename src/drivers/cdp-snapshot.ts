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
  ]);

  function walk(nodeId: string, depth: number): void {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    // Ignored nodes: still recurse into children (Chrome marks structural
    // nodes like <html>/<body> as ignored while their children are not)
    if (node.ignored) {
      if (node.childIds) {
        for (const childId of node.childIds) {
          walk(childId, depth);
        }
      }
      return;
    }

    const role = node.role?.value;
    if (!role || SKIP_ROLES.has(role)) {
      // No role or structural role — recurse into children at same depth
      if (node.childIds) {
        for (const childId of node.childIds) {
          walk(childId, depth);
        }
      }
      return;
    }

    const name = node.name?.value || '';
    const value = node.value?.value;
    const indent = '  '.repeat(depth);

    // Determine if this element gets a ref
    const needsRef = INTERACTIVE_ROLES.has(role) || (name && role !== 'text');

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

    const nameStr = name ? ` "${name}"` : '';
    const valueStr = value !== undefined ? ` [value="${value}"]` : '';

    // Check if node has visible children (not just StaticText/InlineTextBox)
    const hasVisibleChildren = node.childIds?.some((cid) => {
      const child = nodeMap.get(cid);
      if (!child) return false;
      if (child.ignored) return child.childIds?.length ? true : false;
      const cRole = child.role?.value;
      return cRole && !SKIP_ROLES.has(cRole);
    }) ?? false;
    const colon = hasVisibleChildren ? ':' : '';

    lines.push(`${indent}- ${role}${nameStr}${refStr}${valueStr}${colon}`);

    if (node.childIds) {
      for (const childId of node.childIds) {
        walk(childId, depth + 1);
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
