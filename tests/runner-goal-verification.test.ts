import { describe, expect, it } from 'vitest';
import {
  buildGoalVerificationClaim,
  collectSearchWorkflowEvidence,
  detectCompletionContentTypeMismatch,
  detectAiTanglePartnerTemplateVisibleState,
  detectAiTangleVerifiedOutputState,
  shouldAcceptSearchWorkflowCompletion,
  shouldAcceptScriptBackedCompletion,
} from '../src/runner.js';

describe('buildGoalVerificationClaim', () => {
  it('returns the raw claim when no evidence is present', () => {
    expect(buildGoalVerificationClaim('done', [])).toBe('done');
  });

  it('appends supplemental evidence for the verifier', () => {
    expect(buildGoalVerificationClaim('done', ['SCRIPT RESULT:\nmission text']))
      .toContain('SUPPLEMENTAL TOOL EVIDENCE:');
    expect(buildGoalVerificationClaim('done', ['SCRIPT RESULT:\nmission text']))
      .toContain('mission text');
  });

  it('keeps only the most recent evidence entries', () => {
    const claim = buildGoalVerificationClaim('done', [
      'evidence-1',
      'evidence-2',
      'evidence-3',
      'evidence-4',
      'evidence-5',
      'evidence-6',
    ]);
    expect(claim).not.toContain('evidence-1');
    expect(claim).toContain('evidence-2');
    expect(claim).toContain('evidence-3');
    expect(claim).toContain('evidence-4');
    expect(claim).toContain('evidence-5');
    expect(claim).toContain('evidence-6');
  });

  it('accepts script-backed completions when verifier only lacks visible evidence', () => {
    const accepted = shouldAcceptScriptBackedCompletion(
      'Use the site search to find the first related press release and extract the title and date.',
      {
        url: 'https://www.nih.gov/news-events/news-releases/example',
        title: 'Example',
        snapshot: '- heading "Example"',
      },
      {
        achieved: false,
        confidence: 0.73,
        evidence: ['Current page matches the claimed article, but the publication date is not visible in the accessibility tree.'],
        missing: ['Need visible publication date evidence.'],
      },
      [
        'NIH site search used: https://www.nih.gov/search/node?keys=Alzheimer%27s%20disease',
        'Publication date: February 28, 2019',
        'Article URL: https://www.nih.gov/news-events/news-releases/example',
      ].join('\n'),
      [
        'SCRIPT RESULT:\n{"date":"February 28, 2019","title":"Example"}',
      ],
    );

    expect(accepted).toBe(true);
  });

  it('collects persisted site-search evidence from an earlier turn', () => {
    const evidence = collectSearchWorkflowEvidence(
      'Use the site’s search feature to find information on "Alzheimer\'s disease" and extract the title and publication date of the first related press release.',
      [
        'Title: Study measuring changes in protein structure establishes new class of Alzheimer’s biomarkers',
        'Publication date: February 27, 2026',
        'URL: https://www.nih.gov/news-events/news-releases/study-measuring-changes-protein-structure-establishes-new-class-alzheimers-biomarkers',
      ].join('\n'),
      [
        {
          turn: 1,
          durationMs: 1,
          action: { action: 'click', selector: '@l2eda' },
          state: {
            url: 'https://www.nih.gov/news-events/news-releases',
            title: 'News Releases',
            snapshot: [
              '- searchbox "Search NIH news releases" [ref=s1eec] [value="Alzheimer\'s disease"]:',
              '- link "Study measuring changes in protein structure establishes new class of Alzheimer’s biomarkers February 27, 2026" [ref=l2eda]',
            ].join('\n'),
          },
        },
      ],
    );

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toContain('SEARCH WORKFLOW EVIDENCE:');
    expect(evidence[0]).toContain('Query visible in site search: Alzheimer\'s disease');
    expect(evidence[0]).toContain('Visible date evidence: February 27, 2026');
  });

  it('accepts completion when prior turns captured the required search workflow evidence', () => {
    const accepted = shouldAcceptSearchWorkflowCompletion(
      'Use the site’s search feature to find information on "Alzheimer\'s disease" and extract the title and publication date of the first related press release.',
      {
        achieved: false,
        confidence: 0.71,
        evidence: ['The article page matches the claimed result.'],
        missing: ['Current final page state does not show the site search field or filtered search-results state.'],
      },
      [
        'Title: Study measuring changes in protein structure establishes new class of Alzheimer’s biomarkers',
        'Publication date: February 27, 2026',
        'URL: https://www.nih.gov/news-events/news-releases/study-measuring-changes-protein-structure-establishes-new-class-alzheimers-biomarkers',
      ].join('\n'),
      [
        'SEARCH WORKFLOW EVIDENCE:\nURL: https://www.nih.gov/news-events/news-releases\nQuery visible in site search: Alzheimer\'s disease',
      ],
    );

    expect(accepted).toBe(true);
  });

  it('rejects script-backed completions when the goal requires a press release but evidence points to another content type', () => {
    const accepted = shouldAcceptScriptBackedCompletion(
      'Use the site search to find the first related press release and extract the title and date.',
      {
        url: 'https://www.nih.gov/news-events/nih-research-matters/gene-expression-signatures-alzheimers-disease',
        title: "Gene expression signatures of Alzheimer's disease",
        snapshot: '- heading "Gene expression signatures of Alzheimer\'s disease"',
      },
      {
        achieved: false,
        confidence: 0.73,
        evidence: ['The current URL is an NIH Research Matters article, not a press release page.'],
        missing: ['Need the first related press release.'],
      },
      [
        'URL: https://www.nih.gov/news-events/nih-research-matters/gene-expression-signatures-alzheimers-disease',
        `Title: "Gene expression signatures of Alzheimer's disease"`,
        'Publication date: May 14, 2019',
      ].join('\n'),
      [
        `SCRIPT RESULT:\n{"date":"May 14, 2019","title":"Gene expression signatures of Alzheimer's disease"}`,
      ],
    );

    expect(accepted).toBe(false);
  });

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
