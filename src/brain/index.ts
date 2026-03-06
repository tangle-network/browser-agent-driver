/**
 * LLM Decision Engine — multimodal (vision + text), planning, verification,
 * conversation history management, and quality evaluation.
 *
 * Uses Vercel AI SDK for multi-provider support (OpenAI, Anthropic, Google, Codex CLI, Claude Code).
 */

import { generateText } from 'ai';
import type { ModelMessage, LanguageModel } from 'ai';
import type { Action, PageState, AgentConfig, DesignFinding, GoalVerification } from '../types.js';
import { AriaSnapshotHelper } from '../drivers/snapshot.js';
import { resolveProviderApiKey, resolveProviderModelName } from '../provider-defaults.js';
import { buildFirstPartyBoundaryNote } from '../domain-policy.js';
import { generateWithSandboxBackend } from '../providers/sandbox-backend.js';

const SYSTEM_PROMPT = `You are a senior staff engineer operating a browser via Playwright automation.

You can SEE the page (via screenshot) and READ the page structure (via accessibility tree with @ref IDs).
Use BOTH inputs together — the screenshot shows layout/design/visual state, the a11y tree shows interactive elements with refs.

ACTIONS:
- {"action": "click", "selector": "@REF"}
- {"action": "type", "selector": "@REF", "text": "text to type"}
- {"action": "press", "selector": "@REF", "key": "Enter"} (or Tab, Escape, ArrowDown, etc.)
- {"action": "hover", "selector": "@REF"}
- {"action": "select", "selector": "@REF", "value": "option-value"}
- {"action": "scroll", "direction": "up" | "down", "amount": 500} — add "selector": "@REF" to scroll a specific container
- {"action": "navigate", "url": "https://..."}
- {"action": "wait", "ms": 1000}
- {"action": "evaluate", "criteria": "Is the layout professional? Are colors consistent?"}
- {"action": "runScript", "script": "document.querySelector('.count').textContent"} — run JS in page context and get the result. Use for reading content not in the a11y tree (canvas, computed styles, hidden state).
- {"action": "verifyPreview"} — after the app builds, inspect the preview iframe. Returns URL, title, a11y tree, and errors. Use this AFTER you see a preview iframe on the page.
- {"action": "complete", "result": "description of what was accomplished"}
- {"action": "abort", "reason": "why you cannot continue"}

SELECTOR FORMAT:
- CRITICAL: Replace @REF with an actual ref from the ELEMENTS list below (e.g., @b3cee, @t1f2a)
- NEVER invent or guess ref IDs — only use refs that appear as [ref=XXX] in the ELEMENTS list
- Refs are deterministic — same element keeps the same ref across observations
- Fallback: [data-testid="..."], [aria-label="..."], text="...", role=button[name="..."]

RESPONSE FORMAT — respond with ONLY a JSON object:
{
  "plan": ["step 1", "step 2", ...],
  "currentStep": 0,
  "action": { "action": "click", "selector": "@REF_FROM_ELEMENTS" },
  "nextActions": [{ "action": "type", "selector": "@REF_FROM_ELEMENTS", "text": "..." }],
  "reasoning": "Why I chose this action based on what I see",
  "expectedEffect": "What should change (e.g., 'URL should contain /chat/', 'modal should close')"
}

RULES:
1. Respond with ONLY valid JSON, no markdown or extra text
2. Use @ref selectors from the ELEMENTS list — they are stable across turns
3. Include plan, currentStep, reasoning, and expectedEffect in every response
4. Primary action must be in "action". Optional "nextActions" can contain up to 2 safe follow-ups (click/type/press/hover/select/scroll/wait) only when deterministic
5. When the goal is achieved, use "complete" with a detailed result description
6. If stuck after multiple attempts, use "abort" — don't loop forever
7. LOOK at the screenshot — it shows visual state the a11y tree may miss
8. If an action failed, try a DIFFERENT approach (different selector, different strategy)
9. For complex goals, break them into clear plan steps and track progress
10. Use "evaluate" when you need to assess visual quality, layout, or design
11. After the app builds and a preview is visible, use "verifyPreview" to check for errors before completing
12. BLOCKER-FIRST POLICY: if a modal, limit, quota, permission, or error dialog blocks progress, resolve THAT first before continuing the main goal
13. For quota/limit blockers, use an unblock ladder: open manage path -> clean up old test resources if needed -> retry the original action
14. If the same action triggers the same blocker twice, switch strategy immediately (different button/path), do not repeat blind retries

REASONING FRAMEWORK — before choosing an action:
1. What is the current state vs. the goal state? What is missing?
2. What is the smallest action that makes progress toward the goal?
3. If multiple elements could match, prefer the one closest to the user-visible label
4. If an action just failed, identify WHY it failed before trying again
5. Ask: "Is there a blocker preventing progress right now?" If yes, clear blocker first, then continue goal plan

EXAMPLE 1 — Multi-step form fill (use actual refs from ELEMENTS, not these placeholders):
{"plan":["Navigate to signup page","Fill email field","Fill password field","Click submit","Verify success"],"currentStep":1,"action":{"action":"type","selector":"@REF","text":"user@example.com"},"reasoning":"I see the signup form with email input [ref=...] and password input [ref=...]. Starting with email since it is the first required field.","expectedEffect":"Email field should show 'user@example.com'"}

EXAMPLE 2 — Recovery after failure:
{"plan":["Click the send button","Wait for response"],"currentStep":0,"action":{"action":"scroll","direction":"down","amount":300},"reasoning":"My last click failed because the element was not visible in the viewport. I can see from the screenshot that the send button is below the fold. Scrolling down to bring it into view before retrying.","expectedEffect":"The send button should become visible in the viewport"}`;

const FIRST_TURN_COMPACT_PROMPT = `You are a browser agent choosing the fastest safe next action.

Return ONLY valid JSON with:
{
  "plan": ["step 1", "step 2"],
  "currentStep": 0,
  "action": { "action": "click", "selector": "@REF" },
  "nextActions": [],
  "reasoning": "brief reason",
  "expectedEffect": "what should change"
}

Rules:
1. Use exact @ref selectors from ELEMENTS. Never invent refs.
2. Prefer the smallest high-signal action.
3. On landing pages, prefer site search, primary navigation, or an obvious goal-matching link.
4. If a blocker is visible, resolve it first.
5. Do not over-explore on the first turn.
6. Respond with JSON only.`;

const LINK_SCOUT_PROMPT = `You are a browser navigation scout.

Your job is NOT to browse freely. Your only job is to pick the best next visible link from a short candidate list.

You will receive:
- the user goal
- the current URL/title
- the current page structure
- a small ranked candidate list of visible links

Choose the single best candidate that most directly advances the goal.
Prefer:
- first-party links already visible on the current page
- links whose text matches the requested entity/content type
- links that avoid unnecessary search detours

Respond with ONLY a JSON object:
{
  "selector": "@ref",
  "reasoning": "brief reason",
  "confidence": 0.82
}

Rules:
1. selector must exactly match one candidate ref
2. choose only one candidate
3. do not invent refs
4. confidence must be 0 to 1
5. if none are viable, choose the best available candidate anyway`;

const DESIGN_AUDIT_PROMPT = `You are a senior product designer and UX engineer auditing a web application.

Analyze the screenshot and accessibility tree for design quality, UX issues, and visual bugs.

CHECK FOR:
- Layout: misaligned elements, broken grids, inconsistent spacing, overflow/clipping
- Typography: inconsistent font sizes, poor hierarchy, text overflow, unreadable text
- Colors: poor contrast (WCAG AA requires 4.5:1 for text), inconsistent color palette
- Spacing: inconsistent padding/margins, crowded elements, excessive whitespace
- Alignment: elements not vertically/horizontally aligned with their siblings
- Accessibility: missing labels, unclear focus indicators, keyboard traps
- UX: confusing navigation, hidden actions, missing feedback states, dead-end flows
- Visual bugs: z-index issues, overlapping elements, broken images, rendering artifacts

You will also receive CHECKPOINTS — specific conditions to verify. Include a finding for each checkpoint that fails.

For each issue found, categorize it and rate its severity:
- critical: blocks user flow or causes data loss
- major: significantly impacts usability or looks unprofessional
- minor: cosmetic issue, polish improvement

RESPOND WITH ONLY a JSON object:
{
  "score": 7,
  "findings": [
    {
      "category": "layout",
      "severity": "major",
      "description": "Navigation sidebar overlaps main content on narrower viewports",
      "location": "Left sidebar, main content area",
      "suggestion": "Add responsive breakpoint or collapse sidebar below 1024px"
    }
  ]
}

Categories: visual-bug, layout, contrast, alignment, spacing, typography, accessibility, ux
Score: 1-3 = poor, 4-5 = needs work, 6-7 = acceptable, 8-9 = good, 10 = excellent`;

const EVALUATE_PROMPT = `You are evaluating the quality of a web page or application output.

Look at the screenshot and assess:
1. Visual design quality (layout, spacing, colors, typography)
2. Functionality completeness (does it match the intended goal?)
3. Professional polish (would this be acceptable in production?)
4. Accessibility (readable text, good contrast, clear labels)
5. Responsiveness indicators (proper scaling, no overflow)

Respond with ONLY a JSON object:
{
  "score": 8,
  "assessment": "Brief overall assessment",
  "strengths": ["strength 1", "strength 2"],
  "issues": ["issue 1", "issue 2"],
  "suggestions": ["improvement 1", "improvement 2"]
}

Score: 1-3 = poor, 4-5 = needs work, 6-7 = acceptable, 8-9 = good, 10 = excellent`;

export interface BrainDecision {
  action: Action;
  nextActions?: Action[];
  raw: string;
  reasoning?: string;
  plan?: string[];
  currentStep?: number;
  expectedEffect?: string;
  tokensUsed?: number;
}

export interface QualityEvaluation {
  score: number;
  assessment: string;
  strengths: string[];
  issues: string[];
  suggestions: string[];
  raw: string;
  tokensUsed?: number;
}

export interface LinkScoutRecommendation {
  selector: string;
  reasoning: string;
  confidence: number;
  raw: string;
  tokensUsed?: number;
}

/** User message content — text-only or multimodal with screenshot */
type UserContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }>;

export class Brain {
  private modelCache = new Map<string, LanguageModel>();
  private provider: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
  private modelName: string;
  private adaptiveModelRouting: boolean;
  private navModelName?: string;
  private navProvider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
  private explicitApiKey?: string;
  private baseUrl?: string;
  private debug: boolean;
  private history: ModelMessage[] = [];
  private maxHistoryTurns: number;
  private visionEnabled: boolean;
  private visionStrategy: 'always' | 'never' | 'auto';
  private llmTimeoutMs: number;
  private compactFirstTurn: boolean;
  private systemPrompt: string;
  private scoutModelName?: string;
  private scoutProvider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
  private scoutUseVision: boolean;
  private sandboxBackendType?: string;
  private sandboxBackendProfile?: string;
  private sandboxBackendProvider?: string;

  constructor(config: AgentConfig = {}) {
    this.llmTimeoutMs = config.llmTimeoutMs ?? 60_000;
    this.provider = config.provider || 'openai';
    this.modelName = config.model || 'gpt-5.4';
    this.adaptiveModelRouting = config.adaptiveModelRouting === true;
    this.navModelName = config.navModel;
    this.navProvider = config.navProvider;
    this.explicitApiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.systemPrompt = config.systemPrompt || SYSTEM_PROMPT;
    this.debug = config.debug || false;
    this.maxHistoryTurns = config.maxHistoryTurns || 10;
    this.visionEnabled = config.vision !== false;
    this.visionStrategy = config.visionStrategy ?? (this.visionEnabled ? 'always' : 'never');
    this.compactFirstTurn = config.compactFirstTurn === true;
    this.sandboxBackendType = config.sandboxBackendType;
    this.sandboxBackendProfile = config.sandboxBackendProfile;
    this.sandboxBackendProvider = config.sandboxBackendProvider;
    this.scoutModelName = config.scout?.model;
    this.scoutProvider = config.scout?.provider;
    this.scoutUseVision = config.scout?.useVision === true;
  }

  private resolveModelName(
    provider: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend',
    requestedModel?: string,
  ): string {
    return resolveProviderModelName(provider, requestedModel, {
      sandboxBackendType: provider === 'sandbox-backend' ? this.sandboxBackendType : undefined,
    });
  }

  private shouldSendTemperature(modelName = this.modelName): boolean {
    // OpenAI GPT-5 reasoning family currently rejects explicit temperature.
    return !/^gpt-5(?:[.-]|$)/i.test(modelName);
  }

  private generationOptions(
    maxOutputTokens: number,
    selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend'; model?: string },
  ): Record<string, number> {
    const providerName = selection?.provider || this.provider;
    const modelName = this.resolveModelName(providerName, selection?.model || this.modelName);
    return {
      ...(this.shouldSendTemperature(modelName) ? { temperature: 0 } : {}),
      ...(providerName === 'codex-cli' || providerName === 'claude-code' || providerName === 'sandbox-backend'
        ? {}
        : { maxOutputTokens }),
    };
  }

  /** Lazily create the LLM model instance based on provider config */
  private async getModel(selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend'; model?: string }): Promise<LanguageModel> {
    const providerName = selection?.provider || this.provider;
    const modelName = this.resolveModelName(providerName, selection?.model || this.modelName);
    const apiKey = resolveProviderApiKey(providerName, this.explicitApiKey);
    const cacheKey = `${providerName}:${modelName}`;
    const cached = this.modelCache.get(cacheKey);
    if (cached) return cached;

    let model: LanguageModel;
    switch (providerName) {
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        const provider = createAnthropic({
          apiKey,
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        });
        model = provider(modelName) as LanguageModel;
        break;
      }
      case 'google': {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        const provider = createGoogleGenerativeAI({
          apiKey,
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        });
        model = provider(modelName) as LanguageModel;
        break;
      }
      case 'codex-cli': {
        const { codexExec } = await import('ai-sdk-provider-codex-cli');
        const env: Record<string, string> = {};
        if (apiKey) env.OPENAI_API_KEY = apiKey;
        model = codexExec(modelName, {
          allowNpx: process.env.CODEX_ALLOW_NPX !== '0',
          skipGitRepoCheck: true,
          ...(process.env.CODEX_CLI_PATH ? { codexPath: process.env.CODEX_CLI_PATH } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        }) as LanguageModel;
        break;
      }
      case 'claude-code': {
        const { createClaudeCode } = await import('ai-sdk-provider-claude-code');
        const env: Record<string, string> = {};
        if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
        const provider = createClaudeCode({
          defaultSettings: {
            ...(process.env.CLAUDE_CODE_CLI_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_CLI_PATH } : {}),
            permissionMode: 'default',
            allowDangerouslySkipPermissions: false,
            ...(this.debug ? { verbose: true } : {}),
            ...(this.debug
              ? {
                  stderr: (chunk: string) => {
                    const line = chunk.trim();
                    if (line) console.error(`[claude-code] ${line}`);
                  },
                }
              : {}),
            ...(Object.keys(env).length > 0 ? { env } : {}),
          },
        });
        model = provider(modelName) as LanguageModel;
        break;
      }
      default: {
        // 'openai' or any OpenAI-compatible API (LiteLLM, Together, etc.)
        const { createOpenAI } = await import('@ai-sdk/openai');
        const provider = createOpenAI({
          apiKey: apiKey || '',
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        });
        model = provider(modelName) as LanguageModel;
        break;
      }
    }

    this.modelCache.set(cacheKey, model);
    return model;
  }

  private async generate(
    system: string,
    messages: ModelMessage[],
    selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend'; model?: string },
    maxOutputTokens = 800,
  ): Promise<{ text: string; tokensUsed?: number }> {
    const providerName = selection?.provider || this.provider;
    const modelName = this.resolveModelName(providerName, selection?.model || this.modelName);

    if (providerName === 'sandbox-backend') {
      const result = await generateWithSandboxBackend({
        system,
        messages,
        model: modelName,
        timeoutMs: this.llmTimeoutMs,
        debug: this.debug,
        backendType: this.sandboxBackendType,
        backendProfileId: this.sandboxBackendProfile,
        backendModelProvider: this.sandboxBackendProvider,
      });
      return { text: result.text };
    }

    const model = await this.getModel({
      provider: providerName,
      model: modelName,
    });

    const result = await generateText({
      model,
      system,
      messages,
      ...this.generationOptions(maxOutputTokens, { provider: providerName, model: modelName }),
      abortSignal: AbortSignal.timeout(this.llmTimeoutMs),
    });

    return {
      text: result.text,
      tokensUsed: result.usage?.totalTokens,
    };
  }

  private shouldUseNavigationModel(
    state: PageState,
    extraContext?: string,
    turnInfo?: { current: number; max: number },
  ): boolean {
    if (!this.adaptiveModelRouting || !this.navModelName) return false;
    if (turnInfo && turnInfo.current > 4) return false;

    const combined = `${extraContext || ''}\n${state.snapshot}`.toLowerCase();
    const blockerPatterns = [
      /blocker/,
      /quota/,
      /limit reached/,
      /modal/,
      /permission/,
      /verification failed/,
      /stuck/,
      /captcha/,
      /unauthorized/,
      /forbidden/,
      /terminal access required/,
      /subscribe to a plan/,
      /run failed/,
    ];
    return !blockerPatterns.some((p) => p.test(combined));
  }

  /** Reset conversation history (call between scenarios) */
  reset(): void {
    this.history = [];
  }

  /** Get current conversation history */
  getHistory(): ModelMessage[] {
    return [...this.history];
  }

  /** Inject a system-level feedback message into history */
  injectFeedback(feedback: string): void {
    this.history.push({ role: 'user', content: `[SYSTEM FEEDBACK] ${feedback}` });
  }

  /**
   * Build the user message content parts — text + optional screenshot.
   * Multimodal when vision is enabled and screenshot is available.
   */
  private buildUserContent(text: string, screenshot?: string, forceVision = false): UserContent {
    const shouldUseVision = !!screenshot && (
      this.visionStrategy === 'always'
      || (this.visionStrategy === 'auto' && forceVision)
    );
    if (!shouldUseVision) {
      return text;
    }

    return [
      { type: 'text' as const, text },
      {
        type: 'image' as const,
        image: screenshot,
        mediaType: 'image/jpeg',
      },
    ];
  }

  /**
   * Compact conversation history: strip ELEMENTS blocks and screenshots
   * from all but the most recent observation.
   */
  private compactHistory(): ModelMessage[] {
    if (this.history.length === 0) return [];

    return this.history.map((msg, idx) => {
      if (msg.role !== 'user') return msg;

      // Keep the last user message intact
      if (idx >= this.history.length - 2) return msg;

      // Handle multimodal content (array of parts)
      if (Array.isArray(msg.content)) {
        const compacted = msg.content
          // Keep only text parts (strip screenshots from old messages)
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map((part) => ({
            ...part,
            text: this.stripElements(part.text),
          }));
        return { ...msg, content: compacted } as ModelMessage;
      }

      // Handle string content
      if (typeof msg.content === 'string') {
        return { ...msg, content: this.stripElements(msg.content) } as ModelMessage;
      }

      return msg;
    });
  }

  private stripElements(text: string): string {
    return text.replace(
      /ELEMENTS:\n[\s\S]*?(?=\n\n|What action should you take\?|$)/,
      (_match) => {
        // Extract the snapshot text from the ELEMENTS block
        const snapshotStart = _match.indexOf('\n');
        if (snapshotStart === -1) return 'ELEMENTS:\n[previous snapshot]';
        const snapshotText = _match.slice(snapshotStart + 1);
        const compact = AriaSnapshotHelper.formatCompact(snapshotText);
        if (compact.length > 0) {
          return `ELEMENTS (compact):\n${compact}`;
        }
        return 'ELEMENTS:\n[previous snapshot]';
      },
    );
  }

  async decide(
    goal: string,
    state: PageState,
    extraContext?: string,
    turnInfo?: { current: number; max: number },
    options?: { forceVision?: boolean }
  ): Promise<BrainDecision> {
    const useCompactFirstTurn = this.compactFirstTurn && turnInfo?.current === 1;
    const visibleSnapshot = useCompactFirstTurn
      ? compactFirstTurnSnapshot(state.snapshot)
      : state.snapshot;
    let textContent = `GOAL: ${goal}`;

    if (turnInfo) {
      const remaining = turnInfo.max - turnInfo.current;
      textContent += `\nTURN: ${turnInfo.current}/${turnInfo.max} (${remaining} remaining)`;
      if (remaining <= 3) {
        textContent += ` — RUNNING LOW, avoid exploratory navigation; prioritize completing the goal or aborting with a clear blocker reason`;
      }
      if (remaining === 1) {
        textContent += ` — FINAL TURN: return a terminal action only (complete or abort)`;
      }
    }

    textContent += `

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${visibleSnapshot}`;

    // Append snapshot diff when available and compact (< 30% of full snapshot)
    if (state.snapshotDiff && state.snapshotDiff.length < state.snapshot.length * 0.3) {
      textContent += `\n\nSNAPSHOT CHANGES (since last turn):\n${state.snapshotDiff}`;
    }

    if (extraContext) {
      textContent += `\n\n${extraContext}`;
    }

    textContent += '\n\nWhat action should you take?';

    const userContent = this.buildUserContent(textContent, state.screenshot, options?.forceVision === true);
    const useNavModel = this.shouldUseNavigationModel(state, extraContext, turnInfo);
    const effectiveProvider = useNavModel ? (this.navProvider || this.provider) : this.provider;
    const effectiveModel = useNavModel ? (this.navModelName || this.modelName) : this.modelName;

    if (this.debug) {
      const turnNum = Math.floor(this.history.length / 2) + 1;
      const usingVision = !!state.screenshot && (
        this.visionStrategy === 'always' || (this.visionStrategy === 'auto' && options?.forceVision === true)
      );
      console.log(`[Brain] Turn ${turnNum} | URL: ${state.url} | Vision: ${usingVision}`);
      if (this.adaptiveModelRouting) {
        const mode = useNavModel ? 'nav-model' : 'primary-model';
        console.log(`[Brain] Model route: ${mode} (${effectiveProvider}/${effectiveModel})`);
      }
    }

    const messages: ModelMessage[] = [
      ...this.compactHistory(),
      { role: 'user', content: userContent },
    ];

    const result = await this.generate(
      useCompactFirstTurn ? FIRST_TURN_COMPACT_PROMPT : this.systemPrompt,
      messages,
      { provider: effectiveProvider, model: effectiveModel },
      useCompactFirstTurn ? 500 : 1000,
    );

    const raw = result.text;
    const tokensUsed = result.tokensUsed;

    if (!raw) {
      throw new Error('Brain.decide: LLM returned empty response — possible rate limit or model error');
    }

    if (this.debug) {
      console.log('[Brain] Response:', raw.slice(0, 300));
    }

    // Store in history
    this.history.push({ role: 'user', content: userContent });
    this.history.push({ role: 'assistant', content: raw });

    // Trim old history
    const maxMessages = this.maxHistoryTurns * 2;
    if (this.history.length > maxMessages) {
      this.history = this.history.slice(-maxMessages);
    }

    const parsed = this.parse(raw);
    return { ...parsed, raw, tokensUsed };
  }

  /**
   * Evaluate quality of the current page state.
   * Takes a screenshot and asks the LLM to rate the visual quality,
   * design, and professional polish.
   */
  async evaluate(state: PageState, goal: string): Promise<QualityEvaluation> {
    const textContent = `GOAL that was being worked on: ${goal}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

Please evaluate the quality of this page/application.`;

    const userContent = this.buildUserContent(textContent, state.screenshot, true);

    const result = await this.generate(
      EVALUATE_PROMPT,
      [{ role: 'user', content: userContent }],
      undefined,
      800,
    );

    const raw = result.text;
    const tokensUsed = result.tokensUsed;

    if (this.debug) {
      console.log('[Brain] Evaluation:', raw.slice(0, 300));
    }

    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      const rawScore = typeof parsed.score === 'number' ? parsed.score : 5;
      return {
        score: Math.max(1, Math.min(10, rawScore)),
        assessment: parsed.assessment ?? 'No assessment provided',
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        raw,
        tokensUsed,
      };
    } catch {
      return {
        score: 5,
        assessment: 'Failed to parse evaluation response',
        strengths: [],
        issues: [],
        suggestions: [],
        raw,
        tokensUsed,
      };
    }
  }

  async recommendLinkCandidate(
    goal: string,
    state: PageState,
    candidates: Array<{ ref: string; text: string; score: number }>,
    extraContext?: string,
  ): Promise<LinkScoutRecommendation> {
    const topCandidates = candidates.slice(0, 5);
    const lines = [
      `GOAL: ${goal}`,
      '',
      'CURRENT PAGE:',
      `URL: ${state.url}`,
      `Title: ${state.title}`,
      '',
      'ELEMENTS:',
      state.snapshot,
      '',
      'CANDIDATES:',
      ...topCandidates.map((candidate, index) =>
        `${index + 1}. ${candidate.ref} — ${candidate.text} (deterministic score ${candidate.score})`,
      ),
    ];
    if (extraContext) {
      lines.push('', extraContext);
    }
    lines.push('', 'Choose the single best next visible link.');

    const userContent = this.buildUserContent(
      lines.join('\n'),
      state.screenshot,
      this.scoutUseVision,
    );
    const provider = this.scoutProvider || this.navProvider || this.provider;
    const model = this.scoutModelName || this.navModelName || this.modelName;
    const result = await this.generate(
      LINK_SCOUT_PROMPT,
      [{ role: 'user', content: userContent }],
      { provider, model },
      300,
    );

    const raw = result.text;
    const tokensUsed = result.tokensUsed;

    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      const selector = typeof parsed.selector === 'string' ? parsed.selector.trim() : '';
      const candidate = topCandidates.find((entry) => entry.ref === selector);
      if (!candidate) {
        throw new Error('invalid scout selector');
      }
      return {
        selector,
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No scout reasoning provided.',
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
        raw,
        tokensUsed,
      };
    } catch {
      const fallback = topCandidates[0];
      if (!fallback) {
        throw new Error('recommendLinkCandidate requires at least one candidate');
      }
      return {
        selector: fallback.ref,
        reasoning: 'Scout fallback: selected the top deterministic candidate after parse failure.',
        confidence: 0.5,
        raw,
        tokensUsed,
      };
    }
  }

  /**
   * Verify whether the goal was actually achieved.
   * Separate from quality evaluation — this checks goal completion, not polish.
   * Uses a fresh LLM call (no conversation history) to avoid self-confirmation bias.
   */
  async verifyGoalCompletion(
    state: PageState,
    goal: string,
    claimedResult: string,
  ): Promise<GoalVerification> {
    const siteBoundaryNote = buildFirstPartyBoundaryNote(goal, state.url);
    const textContent = `GOAL: ${goal}

AGENT'S CLAIMED RESULT: ${claimedResult}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${state.snapshot}${siteBoundaryNote ? `\n\n${siteBoundaryNote}` : ''}

Was the goal actually achieved? Analyze the current page state carefully.`;

    const userContent = this.buildUserContent(textContent, state.screenshot, true);

    const result = await this.generate(
      `You are verifying whether a browser automation agent actually achieved its goal.

Analyze the page state (screenshot + accessibility tree) and determine if the stated goal was accomplished.

Be STRICT — the agent may claim success prematurely. Check:
1. Does the current page state show the goal was completed?
2. Are there error messages, incomplete forms, or missing elements?
3. Does the URL match what you'd expect after goal completion?
4. Is the claimed result consistent with what's visible on the page?

Respond with ONLY a JSON object:
{
  "achieved": true,
  "confidence": 0.9,
  "evidence": ["The dashboard shows the new item", "URL changed to /success"],
  "missing": []
}

- achieved: true if the goal is clearly met, false if not or uncertain
      - confidence: 0.0 to 1.0 — how sure are you?
      - evidence: specific observations supporting your judgment
      - missing: what's still needed (empty array if achieved)`,
      [{ role: 'user', content: userContent }],
      undefined,
      600,
    );

    const raw = result.text;

    if (this.debug) {
      console.log('[Brain] Goal verification:', raw.slice(0, 300));
    }

    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      return {
        achieved: parsed.achieved === true,
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      };
    } catch {
      // Parse failure — assume not verified (conservative)
      return {
        achieved: false,
        confidence: 0,
        evidence: [],
        missing: ['Failed to parse goal verification response'],
      };
    }
  }

  /**
   * Audit design quality of the current page state.
   * Uses vision to analyze layout, typography, spacing, contrast, and UX.
   * Returns structured findings with categories and severity levels.
   */
  async auditDesign(
    state: PageState,
    goal: string,
    checkpoints: string[]
  ): Promise<{ score: number; findings: DesignFinding[]; raw: string; tokensUsed?: number }> {
    const textContent = `GOAL: ${goal}

CHECKPOINTS to verify:
${checkpoints.map((c, i) => `${i + 1}. ${c}`).join('\n')}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${state.snapshot}

Audit this page for design quality, UX issues, and visual bugs.`;

    const userContent = this.buildUserContent(textContent, state.screenshot, true);

    const result = await this.generate(
      DESIGN_AUDIT_PROMPT,
      [{ role: 'user', content: userContent }],
      undefined,
      1500,
    );

    const raw = result.text;
    const tokensUsed = result.tokensUsed;

    if (this.debug) {
      console.log('[Brain] Design audit:', raw.slice(0, 300));
    }

    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);

      const VALID_CATEGORIES = new Set(['visual-bug', 'layout', 'contrast', 'alignment', 'spacing', 'typography', 'accessibility', 'ux']);
      const VALID_SEVERITIES = new Set(['critical', 'major', 'minor']);

      const findings: DesignFinding[] = Array.isArray(parsed.findings)
        ? parsed.findings.map((f: Record<string, unknown>) => ({
            category: (VALID_CATEGORIES.has(f.category as string) ? f.category : 'ux') as DesignFinding['category'],
            severity: (VALID_SEVERITIES.has(f.severity as string) ? f.severity : 'minor') as DesignFinding['severity'],
            description: String(f.description ?? ''),
            location: String(f.location ?? ''),
            suggestion: String(f.suggestion ?? ''),
          }))
        : [];

      const rawScore = typeof parsed.score === 'number' ? parsed.score : 5;
      return {
        score: Math.max(1, Math.min(10, rawScore)),
        findings,
        raw,
        tokensUsed,
      };
    } catch {
      return {
        score: 5,
        findings: [],
        raw,
        tokensUsed,
      };
    }
  }

  /**
   * Extract reusable knowledge from a completed trajectory.
   * Asks the LLM to identify patterns, timings, reliable selectors,
   * and app quirks from a successful run.
   */
  async extractKnowledge(
    trajectoryText: string,
    domain: string,
  ): Promise<Array<{ type: 'timing' | 'selector' | 'pattern' | 'quirk'; key: string; value: string }>> {
    const result = await this.generate(
      `You are analyzing a browser automation trajectory to extract reusable knowledge.
Extract facts that would help an agent complete similar tasks faster next time.

Respond with ONLY a JSON array of facts:
[
  {"type": "timing", "key": "page-load", "value": "wait 3000ms after navigation for content to hydrate"},
  {"type": "selector", "key": "send-button", "value": "[data-testid='chat-send-button'] is the reliable send button selector"},
  {"type": "pattern", "key": "auth-flow", "value": "Click sign-in → fill email → fill password → click submit → wait for redirect"},
  {"type": "quirk", "key": "lazy-loading", "value": "File tree loads asynchronously — wait for entries before asserting"}
]

Types:
- timing: wait durations, delays that are necessary
- selector: reliable selectors for important elements
- pattern: multi-step interaction sequences
- quirk: app-specific behaviors or gotchas

Only include facts that are genuinely useful. Quality over quantity. Max 10 facts.`,
      [{
        role: 'user',
        content: `Domain: ${domain}\n\nTrajectory:\n${trajectoryText}`,
      }],
      undefined,
      800,
    );

    try {
      let text = result.text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];

      const VALID_TYPES = new Set(['timing', 'selector', 'pattern', 'quirk']);
      return parsed
        .filter((f: Record<string, unknown>) =>
          VALID_TYPES.has(f.type as string) &&
          typeof f.key === 'string' &&
          typeof f.value === 'string'
        )
        .map((f: Record<string, unknown>) => ({
          type: f.type as 'timing' | 'selector' | 'pattern' | 'quirk',
          key: f.key as string,
          value: f.value as string,
        }));
    } catch {
      return [];
    }
  }

  private parse(raw: string): Omit<BrainDecision, 'raw' | 'tokensUsed'> {
    let text = raw.trim();

    // Strip markdown code blocks
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const VALID_ACTIONS = new Set([
      'click', 'type', 'press', 'hover', 'select',
      'scroll', 'navigate', 'wait', 'evaluate', 'runScript',
      'verifyPreview', 'complete', 'abort',
    ]);

    try {
      const parsed = JSON.parse(text);

      const actionObj = parsed.action && typeof parsed.action === 'object' ? parsed.action : parsed;
      const actionType = typeof parsed.action === 'string' ? parsed.action : actionObj?.action;

      if (!actionType) {
        throw new Error('Missing action field');
      }

      if (!VALID_ACTIONS.has(actionType)) {
        throw new Error(`Unknown action "${actionType}". Valid: ${[...VALID_ACTIONS].join(', ')}`);
      }

      const actionData = typeof parsed.action === 'object' ? parsed.action : parsed;
      const action = validateAction(actionType, actionData);

      return {
        action,
        nextActions: parseNextActions(parsed, VALID_ACTIONS),
        reasoning: parsed.reasoning || parsed.thought || parsed.thinking,
        plan: Array.isArray(parsed.plan) ? parsed.plan : undefined,
        currentStep: typeof parsed.currentStep === 'number' ? parsed.currentStep : undefined,
        expectedEffect: parsed.expectedEffect || parsed.expected_effect,
      };
    } catch (err) {
      const parseError = err instanceof Error ? err.message : String(err);
      return {
        // Do not hard-abort the scenario on transient JSON formatting issues.
        // Waiting one turn lets the loop continue and recover on the next model call.
        action: { action: 'wait', ms: 1000 },
        reasoning: `Malformed LLM JSON response (${parseError}). Retrying next turn.`,
      };
    }
  }
}

function compactFirstTurnSnapshot(snapshot: string): string {
  const compact = AriaSnapshotHelper.formatCompact(snapshot);
  const basis = compact.length > 0 ? compact : snapshot;
  const maxChars = 4000;
  if (basis.length <= maxChars) return basis;
  return `${basis.slice(0, maxChars)}\n... [snapshot truncated for first-turn fast path]`;
}

function parseNextActions(parsed: Record<string, unknown>, validActions: Set<string>): Action[] | undefined {
  if (!Array.isArray(parsed.nextActions)) {
    return undefined;
  }

  const nextActions: Action[] = [];
  for (const entry of parsed.nextActions.slice(0, 3)) {
    if (!entry || typeof entry !== 'object') continue;
    const rawEntry = entry as Record<string, unknown>;
    const actionType = typeof rawEntry.action === 'string' ? rawEntry.action : undefined;
    if (!actionType || !validActions.has(actionType)) continue;
    try {
      nextActions.push(validateAction(actionType, rawEntry));
    } catch {
      // Best effort: ignore malformed follow-up action.
    }
  }

  return nextActions.length > 0 ? nextActions : undefined;
}

/**
 * Runtime validation of LLM-parsed action objects.
 * Ensures required fields are present and correctly typed per action variant.
 * Throws on missing/invalid fields so the caller can abort gracefully.
 */
function validateAction(actionType: string, data: Record<string, unknown>): Action {
  const requireStr = (field: string): string => {
    const v = data[field];
    if (typeof v !== 'string' || !v) throw new Error(`${actionType} action requires "${field}" (string)`);
    return v;
  };
  const optStr = (field: string): string => {
    const v = data[field];
    return typeof v === 'string' ? v : '';
  };
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

  switch (actionType) {
    case 'click':
      return { action: 'click', selector: requireStr('selector') };
    case 'type':
      return { action: 'type', selector: requireStr('selector'), text: optStr('text') };
    case 'press':
      return { action: 'press', selector: requireStr('selector'), key: requireStr('key') };
    case 'hover':
      return { action: 'hover', selector: requireStr('selector') };
    case 'select':
      return { action: 'select', selector: requireStr('selector'), value: optStr('value') };
    case 'scroll':
      return {
        action: 'scroll',
        direction: data.direction === 'up' ? 'up' : 'down',
        ...(data.amount != null ? { amount: num(data.amount, 500) } : {}),
      };
    case 'navigate':
      return { action: 'navigate', url: requireStr('url') };
    case 'wait':
      return { action: 'wait', ms: num(data.ms, 1000) };
    case 'evaluate':
      return { action: 'evaluate', criteria: optStr('criteria') };
    case 'runScript':
      return { action: 'runScript', script: requireStr('script') };
    case 'verifyPreview':
      return { action: 'verifyPreview' };
    case 'complete':
      return { action: 'complete', result: optStr('result') };
    case 'abort':
      return { action: 'abort', reason: optStr('reason') || 'No reason provided' };
    default:
      throw new Error(`Unknown action type: ${actionType}`);
  }
}
