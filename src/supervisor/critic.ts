import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type {
  Action,
  PageState,
  SupervisorDirective,
  SupervisorSignal,
  Turn,
} from '../types.js';
import { resolveProviderApiKey, resolveProviderModelName } from '../provider-defaults.js';

export interface SupervisorCriticInput {
  goal: string;
  currentState: PageState;
  recentTurns: Turn[];
  signal: SupervisorSignal;
  provider: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code';
  model: string;
  useVision?: boolean;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  debug?: boolean;
}

type SupervisorUserContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }>;

const SUPERVISOR_PROMPT = `You are a supervising browser-automation strategist.

You are invoked ONLY when the worker agent is hard-stalled.
Return one intervention that is most likely to recover progress.

You may receive:
- a screenshot showing the actual visual layout and modal state
- a text accessibility snapshot listing interactive elements and @ref IDs

Use BOTH when available. Trust the accessibility snapshot for valid selectors.

DECISIONS:
- "none": no intervention
- "inject_feedback": send tactical guidance to the worker agent
- "force_action": execute one browser action immediately
- "abort": end the run when progress is impossible

FOR "force_action":
- Choose one action from: click, type, press, hover, select, scroll, navigate, wait
- If using selector, use ONLY refs present in ELEMENTS as "@refId"
- Prefer low-risk unblock actions before destructive actions

Respond ONLY JSON:
{
  "decision": "inject_feedback",
  "reason": "why this intervention should work",
  "feedback": "clear tactical instruction for the worker",
  "confidence": 0.78,
  "action": { "action": "click", "selector": "@abc123" }
}`;

export async function requestSupervisorDirective(
  input: SupervisorCriticInput,
): Promise<SupervisorDirective> {
  const model = await getModel({
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  });

  const turnSummary = summarizeTurns(input.recentTurns);
  const text = [
    `GOAL: ${input.goal}`,
    '',
    `STALL SIGNAL: severity=${input.signal.severity}; reasons=${input.signal.reasons.join(', ') || 'none'}`,
    `METRICS: unchangedTurns=${input.signal.unchangedTurns}, repeatedActionCount=${input.signal.repeatedActionCount}, errorTurns=${input.signal.errorTurns}, verificationFailures=${input.signal.verificationFailures}`,
    '',
    'RECENT TURNS:',
    turnSummary || '(none)',
    '',
    'CURRENT PAGE:',
    `URL: ${input.currentState.url}`,
    `Title: ${input.currentState.title}`,
    'ELEMENTS:',
    input.currentState.snapshot,
    '',
    'Pick the best intervention now.',
  ].join('\n');

  const userContent = buildSupervisorUserContent(text, input.currentState, input.useVision !== false);
  const result = await generateText({
    model,
    system: SUPERVISOR_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    ...(shouldSendTemperature(input.model) ? { temperature: 0 } : {}),
    ...(input.provider === 'codex-cli' || input.provider === 'claude-code' ? {} : { maxOutputTokens: 700 }),
    abortSignal: AbortSignal.timeout(input.timeoutMs ?? 45_000),
  });

  const raw = result.text?.trim() ?? '';
  if (input.debug) {
    console.log('[Supervisor] Critic response:', raw.slice(0, 400));
  }

  if (!raw) {
    return { decision: 'none', reason: 'empty supervisor response' };
  }

  return parseDirective(raw, input.currentState.snapshot);
}

export function buildSupervisorUserContent(
  text: string,
  currentState: PageState,
  useVision: boolean,
): SupervisorUserContent {
  if (!useVision || !currentState.screenshot) {
    return text;
  }

  return [
    { type: 'text', text },
    {
      type: 'image',
      image: currentState.screenshot,
      mediaType: 'image/jpeg',
    },
  ];
}

function summarizeTurns(turns: Turn[]): string {
  return turns
    .slice(-8)
    .map((turn) => {
      const status = turn.error
        ? `error=${turn.error}`
        : turn.verificationFailure
          ? `verifyFail=${turn.verificationFailure}`
          : 'ok';
      return `- T${turn.turn}: ${turn.action.action} @ ${truncate(turn.state.url, 80)} | ${status}`;
    })
    .join('\n');
}

function truncate(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, maxLen - 3)}...`;
}

function parseDirective(raw: string, snapshot: string): SupervisorDirective {
  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(text) as Record<string, unknown>;
    const decision = normalizeDecision(parsed.decision);
    const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    const feedback = typeof parsed.feedback === 'string' ? parsed.feedback : undefined;
    const confidence = clampConfidence(parsed.confidence);

    if (decision !== 'force_action') {
      return { decision, reason, feedback, confidence, raw };
    }

    const candidateAction = normalizeAction(parsed.action);
    if (!candidateAction) {
      return {
        decision: 'inject_feedback',
        reason: reason || 'invalid force_action payload',
        feedback: feedback || 'Force action was invalid. Re-plan with a different strategy.',
        confidence,
        raw,
      };
    }

    if (!validateSelectorRefs(candidateAction, snapshot)) {
      return {
        decision: 'inject_feedback',
        reason: reason || 'force_action selector not present in current snapshot',
        feedback: feedback || 'Use only selectors visible in current ELEMENTS refs.',
        confidence,
        raw,
      };
    }

    return { decision, action: candidateAction, reason, feedback, confidence, raw };
  } catch {
    return { decision: 'none', reason: 'failed to parse supervisor JSON', raw };
  }
}

function normalizeDecision(value: unknown): SupervisorDirective['decision'] {
  if (value === 'inject_feedback' || value === 'force_action' || value === 'abort') {
    return value;
  }
  return 'none';
}

function clampConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function normalizeAction(value: unknown): Action | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const actionType = typeof data.action === 'string' ? data.action : '';
  const requireStr = (field: string): string | null => {
    const v = data[field];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  const optionalStr = (field: string): string => {
    const v = data[field];
    return typeof v === 'string' ? v : '';
  };
  const asNumber = (field: string, fallback: number): number => {
    const v = data[field];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  switch (actionType) {
    case 'click': {
      const selector = requireStr('selector');
      return selector ? { action: 'click', selector } : null;
    }
    case 'type': {
      const selector = requireStr('selector');
      if (!selector) return null;
      return { action: 'type', selector, text: optionalStr('text') };
    }
    case 'press': {
      const selector = requireStr('selector');
      const key = requireStr('key');
      if (!selector || !key) return null;
      return { action: 'press', selector, key };
    }
    case 'hover': {
      const selector = requireStr('selector');
      return selector ? { action: 'hover', selector } : null;
    }
    case 'select': {
      const selector = requireStr('selector');
      if (!selector) return null;
      return { action: 'select', selector, value: optionalStr('value') };
    }
    case 'scroll': {
      const direction = data.direction === 'up' ? 'up' : 'down';
      const amount = asNumber('amount', 500);
      const selector = typeof data.selector === 'string' ? data.selector : undefined;
      return { action: 'scroll', direction, amount, ...(selector ? { selector } : {}) };
    }
    case 'navigate': {
      const url = requireStr('url');
      if (!url || !/^https?:\/\//i.test(url)) return null;
      return { action: 'navigate', url };
    }
    case 'wait':
      return { action: 'wait', ms: asNumber('ms', 1000) };
    default:
      return null;
  }
}

function validateSelectorRefs(action: Action, snapshot: string): boolean {
  if (!('selector' in action) || typeof action.selector !== 'string') return true;
  const selector = action.selector.trim();
  if (!selector.startsWith('@')) return true;
  const knownRefs = new Set(
    Array.from(snapshot.matchAll(/\[ref=([^\]]+)\]/g)).map((match) => `@${match[1]}`),
  );
  return knownRefs.has(selector);
}

function shouldSendTemperature(modelName: string): boolean {
  return !/^gpt-5(?:[.-]|$)/i.test(modelName);
}

async function getModel(config: {
  provider: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code';
  model: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<LanguageModel> {
  const modelName = resolveProviderModelName(config.provider, config.model);
  const apiKey = resolveProviderApiKey(config.provider, config.apiKey);
  switch (config.provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const provider = createAnthropic({
        apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
      return provider(modelName) as LanguageModel;
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      const provider = createGoogleGenerativeAI({
        apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
      return provider(modelName) as LanguageModel;
    }
    case 'codex-cli': {
      const { codexExec } = await import('ai-sdk-provider-codex-cli');
      const env: Record<string, string> = {};
      if (apiKey) env.OPENAI_API_KEY = apiKey;
      return codexExec(modelName, {
        allowNpx: process.env.CODEX_ALLOW_NPX !== '0',
        skipGitRepoCheck: true,
        ...(process.env.CODEX_CLI_PATH ? { codexPath: process.env.CODEX_CLI_PATH } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      }) as LanguageModel;
    }
    case 'claude-code': {
      const { createClaudeCode } = await import('ai-sdk-provider-claude-code');
      const env: Record<string, string> = {};
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
      const provider = createClaudeCode({
        defaultSettings: {
          ...(process.env.CLAUDE_CODE_CLI_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_CLI_PATH } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        },
      });
      return provider(modelName) as LanguageModel;
    }
    default: {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const provider = createOpenAI({
        apiKey: apiKey || '',
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
      return provider(modelName) as LanguageModel;
    }
  }
}
