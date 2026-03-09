import { describe, it, expect } from 'vitest';
import { slackFormatter } from '../src/formatters/slack.js';
import type { WebhookPayload } from '../src/artifacts/webhook-sink.js';

describe('slackFormatter', () => {
  it('formats suite:complete with summary as rich Slack blocks', () => {
    const payload: WebhookPayload = {
      event: 'suite:complete',
      manifest: [
        { testId: 'signup', type: 'screenshot', name: 'turn-05.jpg', uri: 'file:///a', contentType: 'image/jpeg', sizeBytes: 1000 },
        { testId: 'login', type: 'report-json', name: 'report.json', uri: 'file:///b', contentType: 'application/json', sizeBytes: 5000 },
      ],
      summary: { total: 5, passed: 4, failed: 1 },
    };

    const result = slackFormatter(payload);

    expect(result.text).toBeDefined();
    expect(result.blocks).toBeDefined();
    expect(result.blocks!.length).toBeGreaterThanOrEqual(3);

    // Header block
    expect(result.blocks![0].type).toBe('header');
    expect(result.blocks![0].text!.text).toBe('browser-agent-driver');

    // Summary text should mention pass/fail
    const summaryBlock = result.blocks![1];
    expect(summaryBlock.text!.text).toContain('4/5 passed');
    expect(summaryBlock.text!.text).toContain('1 failed');
    expect(summaryBlock.text!.text).toContain(':x:');
  });

  it('shows green checkmark when all tests pass', () => {
    const payload: WebhookPayload = {
      event: 'suite:complete',
      manifest: [],
      summary: { total: 3, passed: 3, failed: 0 },
    };

    const result = slackFormatter(payload);
    const summaryText = result.blocks![1].text!.text;
    expect(summaryText).toContain(':white_check_mark:');
    expect(summaryText).toContain('All 3 tests passed');
  });

  it('lists test IDs from manifest', () => {
    const payload: WebhookPayload = {
      event: 'suite:complete',
      manifest: [
        { testId: 'signup', type: 'screenshot', name: 'a.jpg', uri: '', contentType: '', sizeBytes: 0 },
        { testId: 'login', type: 'screenshot', name: 'b.jpg', uri: '', contentType: '', sizeBytes: 0 },
        { testId: 'suite', type: 'report-json', name: 'report.json', uri: '', contentType: '', sizeBytes: 0 },
      ],
      summary: { total: 2, passed: 2, failed: 0 },
    };

    const result = slackFormatter(payload);
    const testsBlock = result.blocks!.find((b) => b.text?.text.includes('Tests:'));
    expect(testsBlock).toBeDefined();
    expect(testsBlock!.text!.text).toContain('`signup`');
    expect(testsBlock!.text!.text).toContain('`login`');
    // 'suite' should be filtered out
    expect(testsBlock!.text!.text).not.toContain('`suite`');
  });

  it('formats artifact events as compact messages', () => {
    const payload: WebhookPayload = {
      event: 'artifact',
      testId: 'signup',
      type: 'screenshot',
      name: 'turn-05.jpg',
      uri: 'file:///path',
      contentType: 'image/jpeg',
      sizeBytes: 45230,
    };

    const result = slackFormatter(payload);
    expect(result.text).toContain('screenshot');
    expect(result.text).toContain('signup');
    expect(result.blocks![0].text!.text).toContain('44.2KB');
  });

  it('handles suite:complete without summary', () => {
    const payload: WebhookPayload = {
      event: 'suite:complete',
      manifest: [
        { testId: 'test-1', type: 'screenshot', name: 'a.jpg', uri: '', contentType: '', sizeBytes: 0 },
      ],
    };

    const result = slackFormatter(payload);
    // Should not crash, should still produce blocks
    expect(result.blocks).toBeDefined();
    expect(result.blocks!.length).toBeGreaterThanOrEqual(2);
  });
});
