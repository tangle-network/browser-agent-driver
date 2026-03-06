import type { GoalVerification } from './types.js';

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function toRegistrableDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return hostname.toLowerCase();
  return parts.slice(-2).join('.');
}

function extractGoalHosts(goal: string): string[] {
  const matches = goal.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? [];
  return [...new Set(matches.map((host) => host.toLowerCase()))];
}

export function buildFirstPartyBoundaryNote(goal: string, currentUrl: string): string | undefined {
  const currentHost = safeHostname(currentUrl);
  if (!currentHost) return undefined;

  const goalHosts = extractGoalHosts(goal);
  if (goalHosts.length === 0 || goalHosts.includes(currentHost)) return undefined;

  const currentRoot = toRegistrableDomain(currentHost);
  const sameSiteHost = goalHosts.find((host) => toRegistrableDomain(host) === currentRoot);
  if (!sameSiteHost) return undefined;

  return `SITE BOUNDARY NOTE: The current host "${currentHost}" is a first-party sibling subdomain of "${sameSiteHost}" (shared registrable domain "${currentRoot}"). If the user reached it through official in-site navigation, treat it as the same product/site for completion unless the task clearly depends on the exact host for security, auth, or compliance reasons. Do not fail solely because the subdomain differs.`;
}

export function shouldAcceptFirstPartyBoundaryCompletion(
  goal: string,
  currentUrl: string,
  verification: GoalVerification,
  claimedResult: string,
): boolean {
  if (verification.achieved) return false;
  if (!buildFirstPartyBoundaryNote(goal, currentUrl)) return false;

  const bulletCount = claimedResult
    .split('\n')
    .filter((line) => /^\s*[-*]\s+/.test(line))
    .length;
  if (bulletCount < 3) return false;

  const boundaryText = [...verification.evidence, ...verification.missing].join('\n').toLowerCase();
  const boundarySignals = [
    /subdomain/,
    /host/,
    /domain/,
    /www\./,
    /only use/,
    /constraint/,
    /same site/,
  ];
  const substantiveFailureSignals = [
    /not visible/,
    /not shown/,
    /not displayed/,
    /cannot find/,
    /could not find/,
    /missing categories?/,
    /missing evidence/,
    /error/,
    /form/,
    /button/,
    /dialog/,
  ];

  return boundarySignals.some((pattern) => pattern.test(boundaryText))
    && !substantiveFailureSignals.some((pattern) => pattern.test(boundaryText));
}
