import { describe, expect, it } from 'vitest';
import {
  getPersonaDirective,
  isPersonaId,
  withPersonaDirective,
  listPersonaIds,
} from '../src/personas.js';

describe('persona directives', () => {
  it('recognizes built-in persona ids', () => {
    expect(isPersonaId('alice-blueprint-builder')).toBe(true);
    expect(isPersonaId('auto')).toBe(true);
    expect(isPersonaId('unknown-persona')).toBe(false);
    expect(listPersonaIds()).toEqual(['alice-blueprint-builder', 'auto']);
  });

  it('includes partner-route guidance for alice persona', () => {
    const directive = getPersonaDirective('alice-blueprint-builder');
    expect(directive).toContain('/partner/coinbase');
    expect(directive).toContain('/partner/succinct');
    expect(directive).toContain('/partner/tangle');
    expect(directive).toContain('settings');
    expect(directive).toContain('model/provider configuration');
  });

  it('appends persona directive to base goal', () => {
    const goal = withPersonaDirective({
      persona: 'alice-blueprint-builder',
      goal: 'Create a production-ready Coinbase blueprint app.',
    });

    expect(goal).toContain('Create a production-ready Coinbase blueprint app.');
    expect(goal).toContain('Persona: Alice');
    expect(goal).toContain('Adaptive obstacle handling');
  });

  it('builds adaptive route hints for auto persona', () => {
    const directive = getPersonaDirective('auto', {
      goal: 'Create a Coinbase partner workflow and verify preview',
      startUrl: 'https://ai.tangle.tools',
    });

    expect(directive).toContain('Persona: Adaptive product operator');
    expect(directive).toContain('/partner/coinbase');
    expect(directive).toContain('settings');
    expect(directive).toContain('run/preview');
  });

  it('uses generic web guidance for non-tangle sites', () => {
    const directive = getPersonaDirective('auto', {
      goal: 'Find the first related press release title and publication date',
      startUrl: 'https://www.nih.gov',
    });

    expect(directive).toContain('Adaptive web operator');
    expect(directive).not.toContain('/partner/coinbase');
    expect(directive).not.toContain('dashboard/list views');
  });
});
