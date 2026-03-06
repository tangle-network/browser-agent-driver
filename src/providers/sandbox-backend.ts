import type { ModelMessage } from 'ai';
import { randomUUID } from 'node:crypto';

type UserContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }>;

type SessionCreateResponse = { id: string };
type SessionMessageResponse = { info?: { id?: string } };

type SandboxSessionEvent = {
  type: string;
  properties?: Record<string, unknown> & {
    delta?: string;
    part?: {
      type?: string;
      text?: string;
      messageID?: string;
    };
    error?: {
      message?: string;
      code?: string;
    };
    event?: {
      type?: string;
      item?: {
        type?: string;
        text?: string;
      };
    };
  };
};

export interface SandboxBackendPromptOptions {
  sidecarUrl?: string;
  authToken?: string;
  backendType?: string;
  /** Named sandbox profile/preset identifier */
  backendProfile?: string;
  /** @deprecated Legacy alias for backendProfile */
  backendProfileId?: string;
  backendModelProvider?: string;
  model: string;
  system?: string;
  messages: ModelMessage[];
  timeoutMs?: number;
  debug?: boolean;
}

export interface SandboxBackendPromptResult {
  text: string;
  warnings: string[];
}

function normalizeSidecarUrl(input?: string): string {
  const envUrl = process.env.SANDBOX_SIDECAR_URL || process.env.SIDECAR_URL;
  const raw = input?.trim() || envUrl?.trim() || `http://127.0.0.1:${process.env.SIDECAR_PORT || '8080'}`;
  return raw.replace(/\/$/, '');
}

function resolveAuthToken(input?: string): string | undefined {
  if (input?.trim()) return input.trim();
  if (process.env.SANDBOX_SIDECAR_AUTH_TOKEN?.trim()) return process.env.SANDBOX_SIDECAR_AUTH_TOKEN.trim();
  if (process.env.SIDECAR_AUTH_TOKEN?.trim()) return process.env.SIDECAR_AUTH_TOKEN.trim();
  const tokens = (process.env.SIDECAR_AUTH_TOKENS || '')
    .split(/[,\s]+/g)
    .map((value) => value.trim())
    .filter(Boolean);
  return tokens[0];
}

function resolveBackendType(model: string, explicitType?: string): string {
  const candidate = explicitType?.trim() || process.env.SANDBOX_BACKEND_TYPE?.trim();
  if (candidate) return candidate;
  if (/^(claude|sonnet|opus|haiku)([-: ]|$)/i.test(model)) return 'claude-code';
  if (/^(gpt|o[134]|codex)([-: ]|$)/i.test(model)) return 'codex';
  throw new Error(
    'sandbox-backend requires SANDBOX_BACKEND_TYPE or --sandbox-backend-type when the backend cannot be inferred from the model.',
  );
}

function buildHeaders(authToken?: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };
}

function modelMessageToText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'image') return `[Image attachment: ${part.mediaType}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function buildTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const content = modelMessageToText(message).trim();
    if (!content) continue;
    lines.push(`${message.role.toUpperCase()}:`);
    lines.push(content);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function getLatestUserAttachments(messages: ModelMessage[]): Array<{ type: 'file'; filename: string; mediaType?: string; url: string }> {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  if (!latestUser || !Array.isArray(latestUser.content)) return [];

  const attachments: Array<{ type: 'file'; filename: string; mediaType?: string; url: string }> = [];
  let imageIndex = 0;
  for (const part of latestUser.content) {
    if (part.type !== 'image' || !part.image) continue;
    imageIndex += 1;
    const mediaType = part.mediaType || 'image/jpeg';
    const imageValue = typeof part.image === 'string'
      ? part.image
      : part.image instanceof URL
        ? part.image.toString()
        : null;
    if (!imageValue) continue;
    const url = imageValue.startsWith('data:')
      ? imageValue
      : `data:${mediaType};base64,${imageValue}`;
    const ext = mediaType.includes('png') ? 'png' : 'jpg';
    attachments.push({
      type: 'file',
      filename: `browser-screenshot-${imageIndex}.${ext}`,
      mediaType,
      url,
    });
  }
  return attachments;
}

async function requestJson<T>(
  sidecarUrl: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`${sidecarUrl}${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return text ? JSON.parse(text) as T : {} as T;
}

async function collectAssistantText(
  sidecarUrl: string,
  authToken: string | undefined,
  sessionId: string,
  assistantMessageId: string | undefined,
  timeoutMs: number,
  debug: boolean,
): Promise<{ text: string; warnings: string[] }> {
  const response = await fetch(
    `${sidecarUrl}/agents/events?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Failed to open sidecar event stream: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let errorMessage: string | undefined;
  const warnings: string[] = [];

  const handleEvent = (rawData: string) => {
    const event = JSON.parse(rawData) as SandboxSessionEvent;
    if (debug) {
      console.log('[sandbox-backend:event]', JSON.stringify(event));
    }
    if (event.type === 'warning') {
      const message = typeof event.properties?.message === 'string' ? event.properties.message : '';
      if (message) warnings.push(message);
      return;
    }
    if (event.type === 'session.error') {
      errorMessage = event.properties?.error?.message || 'Sidecar backend session failed';
      return;
    }
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part;
      const messageId = typeof part?.messageID === 'string' ? part.messageID : undefined;
      if (assistantMessageId && messageId && messageId !== assistantMessageId) {
        return;
      }
      const delta = typeof event.properties?.delta === 'string' ? event.properties.delta : undefined;
      if (delta) {
        text += delta;
        return;
      }
      if (part?.type === 'text' && typeof part.text === 'string') {
        text = part.text;
      }
      return;
    }
    if (event.type === 'raw') {
      const rawEvent = event.properties?.event;
      const rawItem = rawEvent?.item;
      if (rawEvent?.type === 'item.completed' && rawItem?.type === 'agent_message' && typeof rawItem.text === 'string') {
        text = rawItem.text;
      }
      return;
    }
    if (event.type === 'message.complete' || event.type === 'session.idle' || event.type === 'done') {
      throw new Error('__SANDBOX_DONE__');
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLines = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        handleEvent(dataLines.join('\n'));
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.message === '__SANDBOX_DONE__')) {
      throw error;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return { text: text.trim(), warnings };
}

export async function generateWithSandboxBackend(
  options: SandboxBackendPromptOptions,
): Promise<SandboxBackendPromptResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const sidecarUrl = normalizeSidecarUrl(options.sidecarUrl);
  const authToken = resolveAuthToken(options.authToken);
  const backendType = resolveBackendType(options.model, options.backendType);
  const backendProfile =
    options.backendProfile?.trim() ||
    options.backendProfileId?.trim() ||
    process.env.SANDBOX_BACKEND_PROFILE?.trim() ||
    process.env.SANDBOX_BACKEND_PROFILE_ID?.trim();
  const backendModelProvider = options.backendModelProvider?.trim() || process.env.SANDBOX_BACKEND_MODEL_PROVIDER?.trim();

  const session = await requestJson<SessionCreateResponse>(
    sidecarUrl,
    '/agents/sessions',
    {
      method: 'POST',
      headers: buildHeaders(authToken),
      body: JSON.stringify({
        title: `abd-${randomUUID()}`,
        backend: {
          type: backendType,
          ...(backendProfile ? { profile: backendProfile } : {}),
          model: {
            model: options.model,
            ...(backendModelProvider ? { provider: backendModelProvider } : {}),
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );

  try {
    const transcript = buildTranscript(options.messages);
    const parts = [
      {
        type: 'text' as const,
        text: transcript,
      },
      ...getLatestUserAttachments(options.messages),
    ];

    const started = await requestJson<SessionMessageResponse>(
      sidecarUrl,
      `/agents/sessions/${encodeURIComponent(session.id)}/messages`,
      {
        method: 'POST',
        headers: buildHeaders(authToken),
        body: JSON.stringify({
          system: options.system,
          parts,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    return await collectAssistantText(
      sidecarUrl,
      authToken,
      session.id,
      started.info?.id,
      timeoutMs,
      options.debug === true,
    );
  } finally {
    await fetch(
      `${sidecarUrl}/agents/sessions/${encodeURIComponent(session.id)}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
      },
    ).catch(() => {});
  }
}
