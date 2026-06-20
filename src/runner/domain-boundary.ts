/**
 * Allowed-domain enforcement: filtering scout candidates to in-scope hosts,
 * blocking disallowed search-result clicks before they fire, and snapping the
 * agent back inside the allowed host set when navigation strays.
 *
 * Extracted from runner.ts via the delegate + host-interface pattern. The
 * BrowserAgent class keeps thin delegators (`filterScoutCandidatesByAllowedDomains`,
 * `inspectDisallowedSearchClick`, `enforceAllowedDomainBoundary`); these free
 * functions hold the method bodies verbatim and read runner state through
 * {@link RunnerDomainHost}, which BrowserAgent `implements` so tsc proves the
 * host surface is complete. Behavior is byte-identical to the inlined versions
 * — same ordering, subdomain tolerance, and message text.
 */

import type { Driver } from '../drivers/types.js';
import type { Action, PageState, Scenario } from '../types.js';

import { safeHostname } from './utils.js';
import { buildSearchResultsGuidance } from './search-guidance.js';
import { domainRoot } from './allowed-domains.js';

/**
 * The slice of runner state the allowed-domain enforcement helpers read. The
 * BrowserAgent class declares `implements RunnerDomainHost`, so a missing or
 * mistyped member is a compile error — this interface IS the safety gate for
 * the extraction.
 */
export interface RunnerDomainHost {
  driver: Driver;
}

export async function filterScoutCandidatesByAllowedDomainsImpl(
  self: RunnerDomainHost,
  candidates: Array<{ ref: string; text: string; score: number }>,
  allowedDomains: string[] | undefined,
): Promise<Array<{ ref: string; text: string; score: number }>> {
  if (!allowedDomains || allowedDomains.length === 0 || !self.driver.inspectSelectorHref) {
    return candidates;
  }

  const allowedHosts = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
  const resolved = await Promise.all(
    candidates.map(async (candidate) => {
      const href = await self.driver.inspectSelectorHref!(candidate.ref).catch(() => undefined);
      const host = href ? safeHostname(href) : undefined;
      return { candidate, host };
    }),
  );
  return resolved
    .filter(({ host }) => !host || allowedHosts.has(host))
    .map(({ candidate }) => candidate);
}

export async function inspectDisallowedSearchClickImpl(
  self: RunnerDomainHost,
  state: PageState,
  scenario: Scenario,
  action: Action,
): Promise<string | undefined> {
  if (action.action !== 'click') return undefined;
  if (!scenario.allowedDomains || scenario.allowedDomains.length === 0) return undefined;
  if (!buildSearchResultsGuidance(state, scenario.goal, scenario.allowedDomains)) return undefined;
  if (!self.driver.inspectSelectorHref) return undefined;

  const href = await self.driver.inspectSelectorHref(action.selector);
  const host = href ? safeHostname(href) : undefined;
  if (!href || !host) return undefined;
  const allowedLower = scenario.allowedDomains.map((domain) => domain.toLowerCase());
  if (allowedLower.includes(host)) return undefined;
  // First-party subdomain tolerance
  if (allowedLower.some((h) => domainRoot(h) === domainRoot(host))) return undefined;

  return [
    `Blocked action: selector ${action.selector} resolves to ${href}, which is outside the allowed host set: ${scenario.allowedDomains.join(', ')}.`,
    'Choose a result from an allowed host instead, even if the snippet text looks relevant.',
  ].join(' ');
}

export async function enforceAllowedDomainBoundaryImpl(
  self: RunnerDomainHost,
  preActionState: PageState,
  scenario: Scenario,
): Promise<string | undefined> {
  if (!scenario.allowedDomains || scenario.allowedDomains.length === 0) return undefined;

  const currentUrl = self.driver.getUrl?.() ?? preActionState.url;
  const currentHost = safeHostname(currentUrl);
  if (!currentHost) return undefined;

  const allowedHosts = scenario.allowedDomains.map((domain) => domain.toLowerCase());
  if (allowedHosts.includes(currentHost)) return undefined;

  // First-party subdomain tolerance: allow navigation within the same registrable domain
  const currentRoot = domainRoot(currentHost);
  if (allowedHosts.some((h) => domainRoot(h) === currentRoot)) return undefined;

  const previousHost = safeHostname(preActionState.url);
  if (previousHost && allowedHosts.includes(previousHost)) {
    await self.driver.execute({ action: 'navigate', url: preActionState.url }).catch(() => {});
  } else if (scenario.startUrl) {
    await self.driver.execute({ action: 'navigate', url: scenario.startUrl }).catch(() => {});
  }

  return [
    `Boundary violation: landed on ${currentUrl}, but the allowed host set is ${allowedHosts.join(', ')}.`,
    'Return to an allowed host and continue from there; do not rely on disallowed subdomains even if their snippet looks relevant.',
  ].join(' ');
}
