/**
 * Persona directive templates for richer, product-realistic user-flow goals.
 * These directives are appended to the task goal before LLM planning.
 */

export const PERSONA_IDS = ['alice-blueprint-builder', 'auto'] as const;

export type PersonaId = (typeof PERSONA_IDS)[number];
type BuiltInPersonaId = Exclude<PersonaId, 'auto'>;

export interface PersonaDirectiveInput {
  persona: PersonaId;
  goal: string;
  startUrl?: string;
}

const BUILTIN_PERSONA_DIRECTIVES: Record<BuiltInPersonaId, string> = {
  'alice-blueprint-builder': [
    'Persona: Alice (technical product engineer) using the Tangle Blueprint Agent app to deliver real work.',
    'Alice objective: create a meaningful project (not a toy prompt), with a Coinbase-oriented implementation path, then verify usable output.',
    'Behavior policy: think proactively, adapt to blockers, and navigate like an experienced user.',
    'Navigation heuristics:',
    '- Find key product routes and controls (dashboard, new project, settings, model/provider configuration, run/preview).',
    '- When needed, discover partner templates/routes, especially /partner/coinbase, /partner/succinct, /partner/tangle.',
    '- If routes are not directly visible, inspect home cards, nav/sidebar links, profile menu, and settings pages.',
    'Adaptive obstacle handling:',
    '- If a project limit/quota blocks progress, open management, clean up stale projects, and continue.',
    '- If auth, modal, or permission blockers appear, resolve them before resuming the primary goal.',
    'Completion criteria:',
    '- A substantive technical prompt is submitted to the target project flow.',
    '- The project/run reaches a usable state (preview/build/chat response visible).',
    '- Final state is verified with concrete evidence from the UI (URL, visible output, and key status).',
  ].join('\n'),
};

function buildAutoDirective(goal: string, startUrl?: string): string {
  const context = `${goal} ${startUrl ?? ''}`.toLowerCase();
  const partnerRoutes: string[] = [];

  if (context.includes('coinbase')) partnerRoutes.push('/partner/coinbase');
  if (context.includes('succinct')) partnerRoutes.push('/partner/succinct');
  if (context.includes('tangle')) partnerRoutes.push('/partner/tangle');
  if (partnerRoutes.length === 0 && startUrl?.includes('ai.tangle.tools')) {
    partnerRoutes.push('/partner/coinbase', '/partner/succinct', '/partner/tangle');
  }

  const routeHint = partnerRoutes.length > 0
    ? `- Check partner/template routes likely relevant to this task: ${partnerRoutes.join(', ')}.`
    : '- Discover available templates/routes via home cards, sidebar, and profile/settings menus.';

  return [
    'Persona: Adaptive product operator (senior technical IC + product mindset) focused on completing realistic end-to-end outcomes.',
    `Primary objective: ${goal}`,
    'Behavior policy: think proactively, adapt to blockers, and prefer high-signal actions over repetitive retries.',
    'Navigation heuristics:',
    '- Map the app quickly: dashboard/list views, create flow, settings, model/provider configuration, run/preview views.',
    routeHint,
    'Adaptive obstacle handling:',
    '- If limits, auth prompts, or modals block progress, resolve the blocker first and then resume the main goal.',
    '- If a route/control fails, try an adjacent route path or alternate entry point before repeating the same action.',
    'Completion criteria:',
    '- A substantive, user-valuable flow is completed (not toy chatter).',
    '- The outcome is verified with concrete UI evidence (URL, visible state, run/preview artifact).',
  ].join('\n');
}

export function getPersonaDirective(persona: PersonaId, context?: { goal: string; startUrl?: string }): string {
  if (persona === 'auto') {
    return buildAutoDirective(context?.goal ?? 'Complete the requested user flow', context?.startUrl);
  }
  return BUILTIN_PERSONA_DIRECTIVES[persona];
}

export function withPersonaDirective(input: PersonaDirectiveInput): string {
  const directive = getPersonaDirective(input.persona, { goal: input.goal, startUrl: input.startUrl });
  return `${input.goal}\n\n${directive}`;
}

export function isPersonaId(value: string): value is PersonaId {
  return PERSONA_IDS.includes(value as PersonaId);
}

export function listPersonaIds(): readonly PersonaId[] {
  return PERSONA_IDS;
}
