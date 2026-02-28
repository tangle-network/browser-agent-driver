/**
 * WebhookSink — POST artifact metadata (and optionally data) to a webhook URL.
 *
 * Implements the ArtifactSink interface. Designed for CI/CD integrations,
 * Slack/Discord notifications, and custom dashboards.
 *
 * Never throws — webhook failures are logged, not fatal (infra-as-best-effort).
 */

import type { Artifact, ArtifactSink, ArtifactManifestEntry, ArtifactType } from './types.js';

export interface WebhookSinkOptions {
  /** Webhook endpoint URL */
  url: string;
  /** Extra headers (e.g., auth tokens) */
  headers?: Record<string, string>;
  /** Only send artifacts of these types. Undefined = send all. */
  events?: ArtifactType[];
  /** Base64-encode artifact data in payload (default: false) */
  includeData?: boolean;
  /** Skip data encoding for artifacts above this size in bytes (default: 1MB) */
  maxPayloadBytes?: number;
  /** Per-request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Number of retry attempts on failure (default: 3) */
  retries?: number;
}

interface WebhookArtifactPayload {
  event: 'artifact';
  testId: string;
  type: ArtifactType;
  name: string;
  uri: string;
  contentType: string;
  sizeBytes: number;
  metadata?: Record<string, string>;
  data?: string;
}

interface WebhookSuiteCompletePayload {
  event: 'suite:complete';
  manifest: ArtifactManifestEntry[];
  summary?: { total: number; passed: number; failed: number };
}

export type WebhookPayload = WebhookArtifactPayload | WebhookSuiteCompletePayload;

const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576; // 1MB
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3;

export class WebhookSink implements ArtifactSink {
  private manifest: ArtifactManifestEntry[] = [];
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly events: Set<ArtifactType> | undefined;
  private readonly includeData: boolean;
  private readonly maxPayloadBytes: number;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: WebhookSinkOptions) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.events = options.events ? new Set(options.events) : undefined;
    this.includeData = options.includeData ?? false;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
  }

  async put(artifact: Artifact): Promise<string> {
    const entry: ArtifactManifestEntry = {
      testId: artifact.testId,
      type: artifact.type,
      name: artifact.name,
      uri: `webhook://${this.url}/${artifact.testId}/${artifact.name}`,
      contentType: artifact.contentType,
      sizeBytes: artifact.data.length,
      metadata: artifact.metadata,
    };

    this.manifest.push(entry);

    // Filter by event type
    if (this.events && !this.events.has(artifact.type)) {
      return entry.uri;
    }

    const payload: WebhookArtifactPayload = {
      event: 'artifact',
      testId: artifact.testId,
      type: artifact.type,
      name: artifact.name,
      uri: entry.uri,
      contentType: artifact.contentType,
      sizeBytes: artifact.data.length,
      metadata: artifact.metadata,
    };

    // Optionally include base64-encoded data
    if (this.includeData && artifact.data.length <= this.maxPayloadBytes) {
      payload.data = artifact.data.toString('base64');
    }

    await this.post(payload);

    return entry.uri;
  }

  getManifest(): ArtifactManifestEntry[] {
    return [...this.manifest];
  }

  async close(summary?: { total: number; passed: number; failed: number }): Promise<void> {
    const payload: WebhookSuiteCompletePayload = {
      event: 'suite:complete',
      manifest: this.manifest,
    };

    if (summary) {
      payload.summary = summary;
    }

    await this.post(payload);
  }

  /** POST JSON with exponential backoff retry. Never throws. */
  private async post(payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const baseDelay = 1000;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.headers,
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) return;

        // Non-retryable client errors (4xx except 429)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return;
        }
      } catch {
        // Network error or timeout — retry
      }

      // Exponential backoff: 1s, 2s, 4s, ...
      if (attempt < this.retries) {
        await sleep(baseDelay * Math.pow(2, attempt));
      }
    }
    // All retries exhausted — silently give up (infra-as-best-effort)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
