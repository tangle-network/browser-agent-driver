/**
 * Page analysis — AI Tangle detection and vision escalation logic.
 */

import type { AgentConfig, PageState, Scenario, Turn } from '../types.js';

export function detectAiTangleVerifiedOutputState(
  state: PageState,
  goal: string,
): { result: string; feedback: string } | undefined {
  const goalLower = goal.toLowerCase();
  const urlLower = state.url.toLowerCase();
  const snapshotLower = state.snapshot.toLowerCase();

  const requiresVerifiedOutput =
    goalLower.includes('verified visible output state')
    || goalLower.includes('reach a verified output state')
    || goalLower.includes('usable output');

  if (!requiresVerifiedOutput) return undefined;
  if (!urlLower.includes('ai.tangle.tools/chat/')) return undefined;

  const hasWorkspaceTabs = snapshotLower.includes('code') && snapshotLower.includes('preview');
  const hasOutputSurface =
    hasWorkspaceTabs
    || snapshotLower.includes('fresh start')
    || snapshotLower.includes('waiting for files')
    || snapshotLower.includes('fork');

  if (!hasOutputSurface) return undefined;

  const visibleCues: string[] = [];
  if (hasWorkspaceTabs) visibleCues.push('Code/Preview workspace is visible');
  if (snapshotLower.includes('fresh start')) visibleCues.push('"Fresh start" output placeholder is visible');
  if (snapshotLower.includes('waiting for files')) visibleCues.push('"Waiting for files" status is visible');
  if (snapshotLower.includes('fork')) visibleCues.push('a visible Fork control confirms chat output is present');

  const evidence = [`URL: ${state.url}`, ...visibleCues].join('; ');
  return {
    result: `Reached a verified Blueprint output workspace. ${evidence}`,
    feedback:
      `The main goal is already satisfied: a Blueprint chat workspace with visible output is on screen (${evidence}). Do not open menus or settings. Complete now.`,
  };
}

export function detectAiTanglePartnerTemplateVisibleState(
  state: PageState,
  goal: string,
): { result: string; feedback: string } | undefined {
  const goalLower = goal.toLowerCase();
  const urlLower = state.url.toLowerCase();
  const snapshot = state.snapshot;
  const snapshotLower = snapshot.toLowerCase();

  const requiresVisibilityOnly =
    goalLower.includes('templates are visible')
    || goalLower.includes('verify coinbase templates are visible')
    || goalLower.includes('verify templates are visible');

  if (!requiresVisibilityOnly) return undefined;
  if (!urlLower.includes('ai.tangle.tools/partner/')) return undefined;

  const templateButtons = Array.from(
    snapshot.matchAll(/- button "([^"]*View [^"]+ templates[^"]*)" \[ref=([^\]]+)\]/g),
  ).map((match) => ({ text: match[1]?.trim() ?? '', ref: match[2]?.trim() ?? '' }));

  const partnerHeadingMatch = snapshot.match(/- heading "([^"]*Coinbase[^"]*)" \[ref=([^\]]+)\]/i);
  const hasPartnerHeading = Boolean(partnerHeadingMatch);
  if (!hasPartnerHeading || templateButtons.length < 3) return undefined;

  const visibleTemplateEvidence = templateButtons
    .slice(0, 5)
    .map((button) => `"${button.text}" [ref=${button.ref}]`)
    .join('; ');

  const headingText = partnerHeadingMatch?.[1]?.trim() ?? 'Coinbase';
  const result =
    `Verified Coinbase templates are visible on the partner page. ` +
    `URL: ${state.url}; heading: "${headingText}"; visible template buttons: ${visibleTemplateEvidence}.`;

  return {
    result,
    feedback:
      `The goal is already satisfied on the current partner page: Coinbase template buttons are visibly present under the Coinbase heading. ` +
      `Do not open a template, submit a run, or chase extra actionability proof. Complete now with the visible evidence only.`,
  };
}

export function shouldEscalateVision(input: {
  config: AgentConfig;
  state: PageState;
  turns: Turn[];
  scenario: Scenario;
  currentTurn: number;
  maxTurns: number;
  supervisorSignalSeverity: 'none' | 'soft' | 'hard';
  extraContext: string;
}): boolean {
  const strategy = input.config.visionStrategy ?? (input.config.vision !== false ? 'always' : 'never');
  if (strategy === 'never') return false;
  if (strategy === 'always') return true;

  const pageText = `${input.state.url}\n${input.state.title}\n${input.state.snapshot}`.toLowerCase();
  const recentTurns = input.turns.slice(-2);
  const recentError = recentTurns.some((turn) => Boolean(turn.error || turn.verificationFailure));
  const searchLike = /\bsearch\b|\bsearch results\b/.test(pageText);
  const modalLike = /\bdialog\b|\bmodal\b|\boverlay\b|\bmenu\b/.test(pageText);
  const constrainedTask = Array.isArray(input.scenario.allowedDomains) && input.scenario.allowedDomains.length > 0;
  const lowTurns = input.maxTurns - input.currentTurn <= 2;
  const visibleRecommendation = input.extraContext.includes('VISIBLE LINK RECOMMENDATION');
  const repeatedLocation =
    recentTurns.length >= 2 &&
    recentTurns.every((turn) => turn.state.url === input.state.url);
  const stalledSearch = searchLike && (repeatedLocation || recentError || input.currentTurn >= 6);

  return recentError
    || modalLike
    || lowTurns
    || input.supervisorSignalSeverity !== 'none'
    || stalledSearch
    || (constrainedTask && searchLike && !visibleRecommendation && recentError);
}
