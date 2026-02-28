/**
 * LLM Decision Engine — multimodal (vision + text), planning, verification,
 * conversation history management, and quality evaluation.
 *
 * Uses Vercel AI SDK for multi-provider support (OpenAI, Anthropic, Google).
 */

import { generateText } from 'ai';
import type { ModelMessage, LanguageModel } from 'ai';
import type { Action, PageState, AgentConfig, DesignFinding } from '../types.js';

const SYSTEM_PROMPT = `You are a senior staff engineer operating a browser via Playwright automation.

You can SEE the page (via screenshot) and READ the page structure (via accessibility tree with @ref IDs).
Use BOTH inputs together — the screenshot shows layout/design/visual state, the a11y tree shows interactive elements with refs.

ACTIONS:
- {"action": "click", "selector": "@REF"}
- {"action": "type", "selector": "@REF", "text": "text to type"}
- {"action": "press", "selector": "@REF", "key": "Enter"} (or Tab, Escape, ArrowDown, etc.)
- {"action": "hover", "selector": "@REF"}
- {"action": "select", "selector": "@REF", "value": "option-value"}
- {"action": "scroll", "direction": "up" | "down", "amount": 500}
- {"action": "navigate", "url": "https://..."}
- {"action": "wait", "ms": 1000}
- {"action": "evaluate", "criteria": "Is the layout professional? Are colors consistent?"}
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
  "reasoning": "Why I chose this action based on what I see",
  "expectedEffect": "What should change (e.g., 'URL should contain /chat/', 'modal should close')"
}

RULES:
1. Respond with ONLY valid JSON, no markdown or extra text
2. Use @ref selectors from the ELEMENTS list — they are stable across turns
3. Include plan, currentStep, reasoning, and expectedEffect in every response
4. Take ONE action per turn
5. When the goal is achieved, use "complete" with a detailed result description
6. If stuck after multiple attempts, use "abort" — don't loop forever
7. LOOK at the screenshot — it shows visual state the a11y tree may miss
8. If an action failed, try a DIFFERENT approach (different selector, different strategy)
9. For complex goals, break them into clear plan steps and track progress
10. Use "evaluate" when you need to assess visual quality, layout, or design
11. After the app builds and a preview is visible, use "verifyPreview" to check for errors before completing

REASONING FRAMEWORK — before choosing an action:
1. What is the current state vs. the goal state? What is missing?
2. What is the smallest action that makes progress toward the goal?
3. If multiple elements could match, prefer the one closest to the user-visible label
4. If an action just failed, identify WHY it failed before trying again

EXAMPLE 1 — Multi-step form fill (use actual refs from ELEMENTS, not these placeholders):
{"plan":["Navigate to signup page","Fill email field","Fill password field","Click submit","Verify success"],"currentStep":1,"action":{"action":"type","selector":"@REF","text":"user@example.com"},"reasoning":"I see the signup form with email input [ref=...] and password input [ref=...]. Starting with email since it is the first required field.","expectedEffect":"Email field should show 'user@example.com'"}

EXAMPLE 2 — Recovery after failure:
{"plan":["Click the send button","Wait for response"],"currentStep":0,"action":{"action":"scroll","direction":"down","amount":300},"reasoning":"My last click failed because the element was not visible in the viewport. I can see from the screenshot that the send button is below the fold. Scrolling down to bring it into view before retrying.","expectedEffect":"The send button should become visible in the viewport"}`;

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

/** User message content — text-only or multimodal with screenshot */
type UserContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }>;

export class Brain {
  private modelInstance: LanguageModel | null = null;
  private provider: string;
  private modelName: string;
  private apiKey?: string;
  private baseUrl?: string;
  private debug: boolean;
  private history: ModelMessage[] = [];
  private maxHistoryTurns: number;
  private visionEnabled: boolean;
  private llmTimeoutMs: number;

  constructor(config: AgentConfig = {}) {
    this.llmTimeoutMs = config.llmTimeoutMs ?? 60_000;
    this.provider = config.provider || 'openai';
    this.modelName = config.model || 'gpt-4o';
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.baseUrl = config.baseUrl;
    this.debug = config.debug || false;
    this.maxHistoryTurns = config.maxHistoryTurns || 10;
    this.visionEnabled = config.vision !== false;
  }

  /** Lazily create the LLM model instance based on provider config */
  private async getModel(): Promise<LanguageModel> {
    if (this.modelInstance) return this.modelInstance;

    switch (this.provider) {
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        const provider = createAnthropic({
          apiKey: this.apiKey,
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        });
        this.modelInstance = provider(this.modelName) as LanguageModel;
        break;
      }
      case 'google': {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        const provider = createGoogleGenerativeAI({
          apiKey: this.apiKey,
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        });
        this.modelInstance = provider(this.modelName) as LanguageModel;
        break;
      }
      default: {
        // 'openai' or any OpenAI-compatible API (LiteLLM, Together, etc.)
        const { createOpenAI } = await import('@ai-sdk/openai');
        const provider = createOpenAI({
          apiKey: this.apiKey || '',
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        });
        this.modelInstance = provider(this.modelName) as LanguageModel;
        break;
      }
    }

    return this.modelInstance;
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
  private buildUserContent(text: string, screenshot?: string): UserContent {
    if (!this.visionEnabled || !screenshot) {
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
      'ELEMENTS:\n[previous snapshot — see current observation]'
    );
  }

  async decide(
    goal: string,
    state: PageState,
    extraContext?: string,
    turnInfo?: { current: number; max: number }
  ): Promise<BrainDecision> {
    let textContent = `GOAL: ${goal}`;

    if (turnInfo) {
      const remaining = turnInfo.max - turnInfo.current;
      textContent += `\nTURN: ${turnInfo.current}/${turnInfo.max} (${remaining} remaining)`;
      if (remaining <= 3) {
        textContent += ` — RUNNING LOW, prioritize completing the goal or abort with a clear reason`;
      }
    }

    textContent += `

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${state.snapshot}`;

    if (extraContext) {
      textContent += `\n\n${extraContext}`;
    }

    textContent += '\n\nWhat action should you take?';

    const userContent = this.buildUserContent(textContent, state.screenshot);

    if (this.debug) {
      const turnNum = Math.floor(this.history.length / 2) + 1;
      console.log(`[Brain] Turn ${turnNum} | URL: ${state.url} | Vision: ${!!state.screenshot && this.visionEnabled}`);
    }

    const model = await this.getModel();

    const messages: ModelMessage[] = [
      ...this.compactHistory(),
      { role: 'user', content: userContent },
    ];

    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      messages,
      temperature: 0,
      maxOutputTokens: 1000,
      abortSignal: AbortSignal.timeout(this.llmTimeoutMs),
    });

    const raw = result.text;
    const tokensUsed = result.usage?.totalTokens;

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

    const userContent = this.buildUserContent(textContent, state.screenshot);

    const model = await this.getModel();

    const result = await generateText({
      model,
      system: EVALUATE_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0,
      maxOutputTokens: 800,
      abortSignal: AbortSignal.timeout(this.llmTimeoutMs),
    });

    const raw = result.text;
    const tokensUsed = result.usage?.totalTokens;

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

    const userContent = this.buildUserContent(textContent, state.screenshot);

    const model = await this.getModel();

    const result = await generateText({
      model,
      system: DESIGN_AUDIT_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0,
      maxOutputTokens: 1500,
      abortSignal: AbortSignal.timeout(this.llmTimeoutMs),
    });

    const raw = result.text;
    const tokensUsed = result.usage?.totalTokens;

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
    const model = await this.getModel();

    const result = await generateText({
      model,
      system: `You are analyzing a browser automation trajectory to extract reusable knowledge.
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
      messages: [{
        role: 'user',
        content: `Domain: ${domain}\n\nTrajectory:\n${trajectoryText}`,
      }],
      temperature: 0,
      maxOutputTokens: 800,
      abortSignal: AbortSignal.timeout(this.llmTimeoutMs),
    });

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
      'scroll', 'navigate', 'wait', 'evaluate',
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
        reasoning: parsed.reasoning || parsed.thought || parsed.thinking,
        plan: Array.isArray(parsed.plan) ? parsed.plan : undefined,
        currentStep: typeof parsed.currentStep === 'number' ? parsed.currentStep : undefined,
        expectedEffect: parsed.expectedEffect || parsed.expected_effect,
      };
    } catch {
      return {
        action: { action: 'abort', reason: `Failed to parse LLM response: ${raw}` },
      };
    }
  }
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
