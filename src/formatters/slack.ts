/**
 * Slack payload formatter for WebhookSink.
 *
 * Transforms WebhookPayload into Slack Block Kit format for incoming webhooks.
 * Use with: new WebhookSink({ url: SLACK_WEBHOOK_URL, formatPayload: slackFormatter })
 */

import type { WebhookPayload } from '../artifacts/webhook-sink.js';

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: Array<{ type: string; text: string; emoji?: boolean }>;
  fields?: Array<{ type: string; text: string }>;
}

interface SlackMessage {
  text: string;
  blocks?: SlackBlock[];
}

/**
 * Format a WebhookPayload as a Slack Block Kit message.
 *
 * - `artifact` events: compact one-liner with test ID and artifact type
 * - `suite:complete` events: rich summary with pass/fail counts and test list
 */
export function slackFormatter(payload: WebhookPayload): SlackMessage {
  if (payload.event === 'suite:complete') {
    return formatSuiteComplete(payload);
  }

  return formatArtifact(payload);
}

function formatSuiteComplete(payload: Extract<WebhookPayload, { event: 'suite:complete' }>): SlackMessage {
  const { manifest, summary } = payload;
  const testIds = [...new Set(manifest.map((e) => e.testId).filter((id) => id !== 'suite'))];

  const hasSummary = summary && summary.total > 0;
  const passed = summary?.passed ?? 0;
  const failed = summary?.failed ?? 0;
  const total = summary?.total ?? testIds.length;

  const allPassed = failed === 0 && passed > 0;
  const icon = allPassed ? ':white_check_mark:' : ':x:';
  const headline = allPassed
    ? `${icon} All ${total} tests passed`
    : `${icon} ${passed}/${total} passed, ${failed} failed`;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'browser-agent-driver', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: headline },
    },
  ];

  if (hasSummary) {
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Passed:* ${passed}` },
        { type: 'mrkdwn', text: `*Failed:* ${failed}` },
        { type: 'mrkdwn', text: `*Total:* ${total}` },
      ],
    });
  }

  // List test IDs
  if (testIds.length > 0 && testIds.length <= 20) {
    const testList = testIds.map((id) => `\`${id}\``).join(', ');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Tests:* ${testList}` },
    });
  }

  // Artifacts count
  const screenshotCount = manifest.filter((e) => e.type === 'screenshot').length;
  const reportCount = manifest.filter((e) => e.type.startsWith('report-')).length;
  if (screenshotCount > 0 || reportCount > 0) {
    const parts: string[] = [];
    if (reportCount > 0) parts.push(`${reportCount} reports`);
    if (screenshotCount > 0) parts.push(`${screenshotCount} screenshots`);
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Artifacts: ${parts.join(', ')}` }],
    });
  }

  return {
    text: headline.replace(/:[a-z_]+:/g, '').trim(), // fallback text without emoji
    blocks,
  };
}

function formatArtifact(payload: Extract<WebhookPayload, { event: 'artifact' }>): SlackMessage {
  const text = `*${payload.type}* \`${payload.name}\` for test \`${payload.testId}\` (${formatBytes(payload.sizeBytes)})`;
  return {
    text: `${payload.type}: ${payload.name} for ${payload.testId}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
