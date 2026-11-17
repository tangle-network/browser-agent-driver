/**
 * Act on the element the model saw (browser-agent-driver#177).
 *
 * A `@ref` from the CDP observation carries the backend node id of the
 * element it named. Before an action, confirm that node is still in the page
 * with the same role and accessible name, then target exactly that node.
 * Resolving by role + name + position instead hits a different element once
 * an earlier action re-renders the page: the second "Add to cart" of a batch
 * becomes the next product's button. When identity cannot be confirmed,
 * TargetChangedError stops the action and the rest of its batch, and the next
 * turn observes again.
 */

import type { CDPSession, Locator, Page } from 'playwright';
import { TargetChangedError, type AriaSnapshotHelper } from './snapshot.js';

type Bound = <T>(promise: Promise<T>, step: string) => Promise<T>;
type AXNodeView = { backendDOMNodeId?: number; ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown } };

let tagSeq = 0;

/** A CDP protocol error (unknown or detached node) means the element is gone; anything else (a timeout) propagates. */
function goneOnProtocolError<T>(fallback: T) {
  return (err: unknown): T => {
    if (err instanceof Error && err.message.includes('Protocol error')) return fallback;
    throw err;
  };
}

export async function locateObserved(
  page: Page,
  snapshot: AriaSnapshotHelper,
  selector: string,
  cdpSession: () => Promise<CDPSession | null>,
  bound: Bound,
): Promise<Locator> {
  const entry = snapshot.lookupRefEntry(selector);
  if (!entry) return snapshot.resolveLocator(page, selector);
  const cdp = entry.backendNodeId !== undefined ? await cdpSession() : null;
  if (cdp && entry.backendNodeId !== undefined) {
    return bindToObservedNode(page, cdp, entry.refId, entry, entry.backendNodeId, bound);
  }
  // Playwright-observation fallback has no node identity: a ref shared by
  // several elements is trustworthy only until the first action after it.
  if (entry.positional && snapshot.hasActedSinceObserve) {
    throw new TargetChangedError(entry.refId, entry, 'it is one of several elements with this role and name, and the page may have changed since', []);
  }
  return snapshot.resolveLocator(page, selector);
}

async function bindToObservedNode(
  page: Page,
  cdp: CDPSession,
  refId: string,
  observed: { role: string; name: string },
  backendNodeId: number,
  bound: Bound,
): Promise<Locator> {
  const changed = (now: string) => new TargetChangedError(refId, observed, now, []);
  const resolved = await bound(cdp.send('DOM.resolveNode', { backendNodeId }), 'DOM.resolveNode')
    .catch(goneOnProtocolError(null));
  const objectId = resolved?.object.objectId;
  if (!objectId) throw changed('the element is no longer in the page');
  try {
    const ax: { nodes: AXNodeView[] } = await bound(
      cdp.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }),
      'Accessibility.getPartialAXTree',
    ).catch(goneOnProtocolError({ nodes: [] as AXNodeView[] }));
    const node = ax.nodes.find((n) => n.backendDOMNodeId === backendNodeId && !n.ignored);
    const role = typeof node?.role?.value === 'string' ? node.role.value : undefined;
    const name = typeof node?.name?.value === 'string' ? node.name.value : '';
    const sameRole = role === observed.role || (observed.role === 'Date' && (role === 'Date' || role === 'time'));
    if (!node || !sameRole || name !== observed.name) {
      throw changed(node ? `it is now ${role ?? 'unknown'} "${name}"` : 'the element is no longer rendered');
    }
    // Tag exactly this node so Playwright's actionability checks and input
    // pipeline act on it and nothing else.
    const token = `${refId}.${++tagSeq}`;
    const tagged = await bound(
      cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function (token) {
          if (!this.isConnected) return false;
          for (const el of (this.ownerDocument || document).querySelectorAll('[data-bad-ref]')) el.removeAttribute('data-bad-ref');
          this.setAttribute('data-bad-ref', token);
          return true;
        }`,
        arguments: [{ value: token }],
        returnByValue: true,
      }),
      'Runtime.callFunctionOn',
    );
    if (tagged.result.value !== true) throw changed('the element was removed from the page');
    return page.locator(`[data-bad-ref="${token}"]`);
  } finally {
    void cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}
