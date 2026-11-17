import { describe, expect, it } from 'vitest';
import {
  detectCompletionContentTypeMismatch,
  detectAiTanglePartnerTemplateVisibleState,
  detectAiTangleVerifiedOutputState,
} from '../src/runner.js';

describe('runner goal verification', () => {
  it('rejects complete actions that claim success on non-release article pages', () => {
    const mismatch = detectCompletionContentTypeMismatch(
      'Use the site search to find the first related press release and extract the title and date.',
      {
        url: 'https://www.nih.gov/news-events/nih-research-matters/blood-tests-show-promise-early-alzheimers-diagnosis',
        title: "Blood tests show promise for early Alzheimer's diagnosis",
        snapshot: '- heading "Blood tests show promise for early Alzheimer\'s diagnosis"',
      },
      [
        'Title: Blood tests show promise for early Alzheimer\'s diagnosis',
        'Publication date: August 18, 2020',
        'URL: https://www.nih.gov/news-events/nih-research-matters/blood-tests-show-promise-early-alzheimers-diagnosis',
      ].join('\n'),
      [
        'SCRIPT RESULT:\n{"date":"August 18, 2020","title":"Blood tests show promise for early Alzheimer\'s diagnosis"}',
      ],
    );

    expect(mismatch).toContain('not a press release');
  });

  it('detects a verified ai.tangle.tools output workspace for blocker-recovery flows', () => {
    const completion = detectAiTangleVerifiedOutputState(
      {
        url: 'https://ai.tangle.tools/chat/chat-123',
        title: 'Blueprint Agent',
        snapshot: [
          '- tab "Code"',
          '- tab "Preview"',
          '- heading "Fresh start"',
          '- button "Fork" [ref=b42]',
        ].join('\n'),
      },
      'Attempt Coinbase template start, resolve blocker modals or project-limit path if present, and reach a verified visible output state.',
    );

    expect(completion?.result).toContain('Reached a verified Blueprint output workspace');
    expect(completion?.feedback).toContain('Complete now');
  });

  it('detects visible partner template evidence and completes without launching a run', () => {
    const completion = detectAiTanglePartnerTemplateVisibleState(
      {
        url: 'https://ai.tangle.tools/partner/coinbase',
        title: 'Tangle Blueprint Agent',
        snapshot: [
          '- heading "Coinbase Coinbase" [ref=h32eb]',
          '- button "View E-commerce with Coinbase templates" [ref=b3862]',
          '- button "View Embedded Wallet Starter templates" [ref=b138b]',
          '- button "View Advanced Trade Bot templates" [ref=b337a]',
          '- button "View USDC Payments templates" [ref=b2d9b]',
        ].join('\n'),
      },
      'As a logged-in user, navigate to /partner/coinbase and verify Coinbase templates are visible with concrete evidence.',
    );

    expect(completion?.result).toContain('Verified Coinbase templates are visible on the partner page');
    expect(completion?.feedback).toContain('Do not open a template');
  });
});
