/**
 * LLM Decision Engine — multimodal (vision + text), planning, verification,
 * conversation history management, and quality evaluation.
 *
 * Uses Vercel AI SDK for multi-provider support (OpenAI, Anthropic, Google, Codex CLI, Claude Code).
 */

import { generateText, streamText } from 'ai';
import type { ModelMessage, LanguageModel, SystemModelMessage } from 'ai';
import type { Action, PageState, AgentConfig, DesignFinding, GoalVerification } from '../types.js';
import { AriaSnapshotHelper } from '../drivers/snapshot.js';
import {
  resolveProviderApiKey,
  resolveProviderModelName,
  isClaudeCodeRoutedModel,
  ZAI_OPENAI_BASE_URL,
  ZAI_ANTHROPIC_BASE_URL,
} from '../provider-defaults.js';
import { buildFirstPartyBoundaryNote } from '../domain-policy.js';
import { generateWithSandboxBackend } from '../providers/sandbox-backend.js';

/** Core system prompt: preamble, actions, format, and rules 1-14 (always sent) */
const CORE_RULES = `You are a senior staff engineer operating a browser via Playwright automation.

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
- {"action": "fill", "fields": {"@t1": "Jordan", "@t2": "Rivera"}, "selects": {"@s1": "WA"}, "checks": ["@c1", "@c2"]} — BATCH fill multiple form fields, dropdowns, and checkboxes in ONE turn. Use this whenever you can see 2+ form fields you need to fill — it's dramatically faster than per-field type/click. fields/selects/checks are all optional but at least one must be non-empty.
- {"action": "clickSequence", "refs": ["@r1", "@r2", "@r3"]} — click a known sequence of refs in order. Use for multi-step UI navigation chains where the click order is obvious from the page structure.
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
15. BATCH FILL FOR MULTI-FIELD FORMS: when you can see 2+ form fields that need to be filled, ALWAYS use a single "fill" action with all the fields at once instead of multiple type/click turns. A 5-field form takes 1 turn with fill, not 10 turns with type. Same for dropdowns (use selects map) and checkboxes (use checks array). The page rarely cares which order fields are filled — batch them.
   - CRITICAL: every key in fields/selects/checks MUST be an @ref taken VERBATIM from the ELEMENTS list (e.g., "@t1f2a"), or a simple [data-testid="..."] selector copied from the DATA-TESTID SELECTORS section. NEVER invent CSS combinators like "[data-testid=\"x\"] input" or "@refXXX child". If a target doesn't appear in the snapshot, use single-step type/click for it instead.
   - Date inputs (type="date") and spinbuttons (year/month/day) typically need single-step "type" actions, NOT batch fill. They have non-text input behavior that confuses Playwright's fill(). Skip them in your batch and handle them with type after.
   - If a batch fill fails, do NOT retry the same batch on the next turn. The error message will tell you which target failed — switch to single-step type/click for that target and shrink your next batch to just the targets that work.`;

/** Search-related rules (15-17): injected when page has search elements or /search URL */
const SEARCH_RULES = `
15. SEARCH FORMS: Always interact with the form (type in search box, then click Search or press Enter). Do NOT navigate to a URL with search query parameters — many sites require form submission to trigger filtering. If a search yields no results, try the page's own search box rather than the site-wide search
16. CONTENT DISCOVERY: If the ELEMENTS list doesn't show the link/content you need (e.g., the page has many links but the a11y tree is truncated), use runScript to find it: document.querySelectorAll('a[href]') filtered by keyword. Navigate to the discovered URL directly instead of clicking blindly through menus
17. EXTERNAL SEARCH REDIRECTS: If a site's search form redirects to an external search engine (e.g., search.usa.gov for .gov sites), the results still link back to the original site. Click a relevant search result link — it will take you to the target domain. Do NOT abandon search results to navigate the target site manually`;

/** Data extraction rules (18, 21-23): injected when goal involves extracting data */
const DATA_EXTRACTION_RULES = `
18. DATA EXTRACTION: When the goal asks for specific data (prices, ratings, counts, names) from a list or search results page, use runScript to extract all needed data at once: e.g., document.querySelectorAll('.product-card').forEach(...). Do NOT click into each individual item when the data is visible on the list page. Extract first, then complete with the extracted data
21. EFFICIENT COMPLETION: When you have enough data to answer the goal, complete immediately. Do not navigate to additional pages for "confirmation" if the data was already extracted via runScript or is visible in the current a11y tree. Include all extracted data in the completion result
22. EXTRACT BEFORE NAVIGATING: On search results, directory listings, or any page showing multiple items, ALWAYS extract ALL needed data via runScript BEFORE clicking into individual items. This includes names, phone numbers, addresses, ratings, prices — anything visible on list cards. Use: document.querySelectorAll('.result-card, .listing, [class*="card"]') to grab everything at once. Many sites use anti-bot protection on detail pages but leave listing pages accessible. If you can answer the goal from list-level data, do so without navigating deeper. NEVER click into 3+ individual items when the data is on the list page
23. FILTER vs SEARCH: When a goal asks to filter results (e.g., "under $50", "4+ stars"), look for filter controls (sliders, dropdowns, checkboxes in a sidebar or toolbar) rather than typing filter values into the search box. Search boxes are for keyword queries, not numeric filters. After applying a filter: (1) wait 2-3 seconds for results to update, (2) verify the filter took effect by checking the updated results, (3) extract the filtered data via runScript. Do NOT keep searching for more filter controls after one is applied — extract and complete`;

/** Heavy page rules (19-20, 24): injected when snapshot is large or turn count is high */
const HEAVY_PAGE_RULES = `
19. FORM FIELD TARGETING: Before typing, verify you are targeting the correct input field using its @ref from the ELEMENTS list. If multiple inputs are visible (e.g., search box + price filter), ensure you select the right one by checking its label or placeholder text in the a11y tree. Never assume focus — always specify the exact @ref
20. SECTION NAVIGATION: When you need to find a specific section (e.g., rugby, sports, travel) and the nav links aren't in the truncated a11y tree, use runScript to discover navigation: JSON.stringify(Array.from(document.querySelectorAll('nav a, header a, [role="navigation"] a, .nav a')).slice(0, 30).map(a => ({text: a.textContent.trim(), href: a.href}))). Then navigate directly to the matching section URL
24. HEAVY PAGE RECOVERY: If a page takes very long to load or seems stuck, do NOT wait — use runScript to check document.readyState and extract whatever content is already in the DOM. Partial data is better than a timeout. If the page is completely blank, try navigating to a simpler version (mobile site, search page) instead of waiting`;

/** Reasoning framework and examples (always appended after rules) */
const REASONING_SUFFIX = `

REASONING FRAMEWORK — before choosing an action:
1. What is the current state vs. the goal state? What is missing?
2. What is the smallest action that makes progress toward the goal?
3. If multiple elements could match, prefer the one closest to the user-visible label
4. If an action just failed, identify WHY it failed before trying again
5. Ask: "Is there a blocker preventing progress right now?" If yes, clear blocker first, then continue goal plan

EXAMPLE 1 — Multi-step form fill (use actual refs from ELEMENTS, not these placeholders):
{"plan":["Navigate to signup page","Fill email field","Fill password field","Click submit","Verify success"],"currentStep":1,"action":{"action":"type","selector":"@REF","text":"user@example.com"},"reasoning":"I see the signup form with email input [ref=...] and password input [ref=...]. Starting with email since it is the first required field.","expectedEffect":"Email field should show 'user@example.com'"}

EXAMPLE 2 — Recovery after failure:
{"plan":["Click the send button","Wait for response"],"currentStep":0,"action":{"action":"scroll","direction":"down","amount":300},"reasoning":"My last click failed because the element was not visible in the viewport. I can see from the screenshot that the send button is below the fold. Scrolling down to bring it into view before retrying.","expectedEffect":"The send button should become visible in the viewport"}

EXAMPLE 3 — Batch fill a multi-field form (one turn instead of ten):
{"plan":["Fill all visible Personal Info fields","Click Next","Fill Contact step","Submit"],"currentStep":0,"action":{"action":"fill","fields":{"@firstname":"Jordan","@lastname":"Rivera","@dob":"1990-04-15"},"selects":{"@gender":"other"}},"reasoning":"Step 1 of the form has 3 text fields and 1 select all visible at once. Filling them in a single batch action saves 7 turns vs typing each individually.","expectedEffect":"All four Step 1 fields populated with the supplied values"}`;

/** Full static prompt (all rules) — used as default when config.systemPrompt is not set */
const SYSTEM_PROMPT = CORE_RULES + SEARCH_RULES + DATA_EXTRACTION_RULES + HEAVY_PAGE_RULES + REASONING_SUFFIX;

/** Pattern for detecting data-extraction keywords in goal text */
const DATA_EXTRACTION_PATTERN = /\b(extract|list|find|data|price|pric|names?|rating|cost|count)\b/i;

/** Pattern for detecting search-related roles in snapshot text */
const SEARCH_SNAPSHOT_PATTERN = /^\s*-\s+(?:searchbox|combobox)\s/m;

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

const LINK_SCOUT_PROMPT = `Pick the best link from CANDIDATES to advance the GOAL. Respond with ONLY JSON:
{"selector":"@ref","reasoning":"brief reason","confidence":0.82}
Rules: use exact candidate ref, pick one, confidence 0-1, prefer first-party and text-matching links.`;

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
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Prompt-cache hit tokens (provider-agnostic). Reads from the AI SDK's
   * unified `usage.inputTokenDetails.cacheReadTokens` field. Populated by:
   *   - OpenAI / ZAI / GLM via automatic server-side caching
   *   - Anthropic via the cache_control markers set in buildSystemForDecide
   */
  cacheReadInputTokens?: number;
  /** Prompt-cache write tokens (cache miss, first turn — provider-agnostic) */
  cacheCreationInputTokens?: number;
  /** Which model handled this decision (for cost tracking with adaptive routing) */
  modelUsed?: string;
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

const JSON_TEXT_OUTPUT = {
  name: 'json-text',
  responseFormat: Promise.resolve({ type: 'json' as const }),
  async parseCompleteOutput({ text }: { text: string }) {
    return text;
  },
  async parsePartialOutput({ text }: { text: string }) {
    return { partial: text };
  },
  createElementStreamTransform() {
    return undefined;
  },
};

export class Brain {
  private modelCache = new Map<string, LanguageModel>();
  private provider: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  private modelName: string;
  private adaptiveModelRouting: boolean;
  private navModelName?: string;
  private navProvider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  private explicitApiKey?: string;
  private baseUrl?: string;
  private debug: boolean;
  private history: ModelMessage[] = [];
  private maxHistoryTurns: number;
  private visionEnabled: boolean;
  private visionStrategy: 'always' | 'never' | 'auto';
  private llmTimeoutMs: number;
  private compactFirstTurn: boolean;
  private lastDecisionUrl?: string;
  private systemPrompt: string;
  private scoutModelName?: string;
  private scoutProvider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  private scoutUseVision: boolean;
  private sandboxBackendType?: string;
  private sandboxBackendProfile?: string;
  private sandboxBackendProvider?: string;
  // Extension-supplied rules. Set via setExtensionRules() — null/undefined
  // when no extensions are loaded (default).
  private extensionRules?: { global?: string; search?: string; dataExtraction?: string; heavy?: string };
  private extensionDomainRules?: Record<string, { extraRules?: string }>;

  constructor(config: AgentConfig = {}) {
    this.llmTimeoutMs = config.llmTimeoutMs ?? 60_000;
    this.provider = config.provider || 'openai';
    this.modelName = config.model || 'gpt-5.4';
    this.adaptiveModelRouting = config.adaptiveModelRouting === true;
    // Default nav model to gpt-4.1-mini when adaptive routing is on (9x cheaper output than gpt-5.4)
    this.navModelName = config.navModel || (this.adaptiveModelRouting ? 'gpt-4.1-mini' : undefined);
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
    provider: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan',
    requestedModel?: string,
  ): string {
    return resolveProviderModelName(provider, requestedModel, {
      sandboxBackendType: provider === 'sandbox-backend' ? this.sandboxBackendType : undefined,
    });
  }

  private shouldSendTemperature(modelName = this.modelName): boolean {
    // OpenAI GPT-5 reasoning family currently rejects explicit temperature.
    return !/(^|\/)gpt-5(?:[.-]|$)/i.test(modelName);
  }

  private generationOptions(
    maxOutputTokens: number,
    selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan'; model?: string },
  ): Record<string, unknown> {
    const providerName = selection?.provider || this.provider;
    const modelName = this.resolveModelName(providerName, selection?.model || this.modelName);
    // CLI-spawning providers (codex-cli, claude-code, and zai-coding-plan
    // when routed through claude-code) don't accept maxOutputTokens through
    // the AI SDK shape — the subprocess controls its own output.
    const isCliSpawning =
      providerName === 'codex-cli' ||
      providerName === 'claude-code' ||
      providerName === 'sandbox-backend' ||
      (providerName === 'zai-coding-plan' && isClaudeCodeRoutedModel(modelName));
    const omitsLegacyMaxTokens = providerName === 'cli-bridge' || /(^|\/)gpt-5(?:[.-]|$)/i.test(modelName);
    return {
      ...(this.shouldSendTemperature(modelName) ? { temperature: 0 } : {}),
      ...(isCliSpawning || omitsLegacyMaxTokens ? {} : { maxOutputTokens }),
      ...(providerName === 'openai' && /(^|\/)gpt-5(?:[.-]|$)/i.test(modelName)
        ? {
            providerOptions: {
              openai: {
                forceReasoning: true,
                maxCompletionTokens: maxOutputTokens,
              },
            },
          }
        : {}),
    };
  }

  /** Get a LLM model instance, optionally with provider/model override (e.g. for CAPTCHA fallback) */
  async getLanguageModel(selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge'; model?: string }): Promise<LanguageModel> {
    return this.getModel(selection)
  }

  /** Lazily create the LLM model instance based on provider config */
  private async getModel(selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan'; model?: string }): Promise<LanguageModel> {
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
      case 'cli-bridge': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        const rawUrl = this.baseUrl || process.env.CLI_BRIDGE_URL;
        if (!rawUrl) {
          throw new Error('cli-bridge provider requires CLI_BRIDGE_URL or --base-url');
        }
        const baseURL = rawUrl.endsWith('/v1') ? rawUrl : `${rawUrl.replace(/\/+$/, '')}/v1`;
        const provider = createOpenAI({
          apiKey: apiKey || '',
          baseURL,
        });
        model = provider.chat(modelName) as LanguageModel;
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
      case 'zai-coding-plan': {
        // Z.ai coding plan: GLM models (glm-4.6, glm-4.5-air) at a fraction
        // of Anthropic prices. Two backends:
        //   1. Default — OpenAI-compatible endpoint, native GLM models
        //   2. claude-code routed — spawn the Claude Code CLI subprocess
        //      with ANTHROPIC_BASE_URL/AUTH_TOKEN env vars pointed at Z.ai's
        //      Anthropic-compatible endpoint. The user gets the Claude Code
        //      agent loop with Z.ai pricing.
        if (!apiKey) {
          throw new Error(
            'zai-coding-plan: API key required (set ZAI_API_KEY env var or pass --api-key)',
          );
        }
        if (isClaudeCodeRoutedModel(modelName)) {
          const { createClaudeCode } = await import('ai-sdk-provider-claude-code');
          const env: Record<string, string> = {
            // Override Claude Code's API base + auth at the env-var level.
            // The CLI subprocess inherits these and routes all Anthropic
            // API calls to Z.ai's Anthropic-compatible endpoint.
            ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_BASE_URL,
            ANTHROPIC_AUTH_TOKEN: apiKey,
            // Some Claude Code versions still read ANTHROPIC_API_KEY — set
            // both so we don't depend on which env var name wins.
            ANTHROPIC_API_KEY: apiKey,
          };
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
                      if (line) console.error(`[zai-claude-code] ${line}`);
                    },
                  }
                : {}),
              env,
            },
          });
          // The Claude Code SDK takes a model alias (sonnet/haiku/opus); when
          // the user passes a glm-* name we just hand it through — Claude
          // Code passes it as the model param to the upstream API, which is
          // Z.ai's Anthropic-compat endpoint that maps it to the right glm.
          // For 'claude-code'/'cc' we default to 'sonnet' which Z.ai aliases
          // to its strongest glm model under the coding plan.
          const ccModel = modelName === 'claude-code' || modelName === 'cc' ? 'sonnet' : modelName;
          model = provider(ccModel) as LanguageModel;
          break;
        }
        // Default path — direct OpenAI-compatible API to Z.ai. Z.ai's
        // paas/v4 endpoint only implements `/chat/completions` (no
        // `/responses`), so we MUST use `provider.chat(model)` rather than
        // the bare `provider(model)` call which now defaults to the new
        // OpenAI Responses API in @ai-sdk/openai v3+.
        const { createOpenAI } = await import('@ai-sdk/openai');
        const provider = createOpenAI({
          apiKey,
          baseURL: ZAI_OPENAI_BASE_URL,
        });
        model = provider.chat(modelName) as LanguageModel;
        break;
      }
      default: {
        // 'openai' or any OpenAI-compatible API (LiteLLM, Together, etc.).
        // Same reason as the zai-coding-plan branch above: most third-party
        // OpenAI-compatible proxies (LiteLLM, vLLM, Together) implement
        // `/chat/completions` but not the new `/responses` API. Use the
        // chat factory explicitly so we hit a path the upstream actually
        // serves.
        const { createOpenAI } = await import('@ai-sdk/openai');
        const provider = createOpenAI({
          apiKey: apiKey || '',
          ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
        });
        model = provider.chat(modelName) as LanguageModel;
        break;
      }
    }

    this.modelCache.set(cacheKey, model);
    return model;
  }

  private async generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: { provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan'; model?: string },
    maxOutputTokens = 800,
  ): Promise<{ text: string; tokensUsed?: number; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> {
    const providerName = selection?.provider || this.provider;
    const modelName = this.resolveModelName(providerName, selection?.model || this.modelName);

    // Sandbox backend doesn't accept structured system messages — flatten.
    const systemForSandbox = typeof system === 'string'
      ? system
      : system.map(m => m.content).join('\n\n');

    if (providerName === 'sandbox-backend') {
      const result = await generateWithSandboxBackend({
        system: systemForSandbox,
        messages,
        model: modelName,
        timeoutMs: this.llmTimeoutMs,
        debug: this.debug,
        backendType: this.sandboxBackendType,
        backendProfile: this.sandboxBackendProfile,
        backendModelProvider: this.sandboxBackendProvider,
      });
      return { text: result.text };
    }

    const model = await this.getModel({
      provider: providerName,
      model: modelName,
    });

    // Anthropic supports structured system messages with cache_control. For
    // every other provider, flatten back to a string — they ignore the array
    // form's per-message provider options anyway, and some (claude-code,
    // codex-cli) wrap their own subprocess CLI which only takes plain text.
    const systemForRequest = providerName === 'anthropic' || typeof system === 'string'
      ? system
      : systemForSandbox;

    const generationSettings = {
      model,
      system: systemForRequest,
      messages,
      ...(providerName === 'cli-bridge' ? { output: JSON_TEXT_OUTPUT } : {}),
      ...this.generationOptions(maxOutputTokens, { provider: providerName, model: modelName }),
      abortSignal: AbortSignal.timeout(this.llmTimeoutMs),
    };
    const result = providerName === 'cli-bridge'
      ? await (async () => {
          const streamed = streamText(generationSettings);
          const [text, usage, providerMetadata] = await Promise.all([
            streamed.text,
            streamed.totalUsage,
            streamed.providerMetadata,
          ]);
          return { text, usage, providerMetadata };
        })()
      : await generateText(generationSettings);

    // Extract prompt-cache stats from the AI SDK's PROVIDER-AGNOSTIC fields:
    //   result.usage.inputTokenDetails.{cacheReadTokens, cacheWriteTokens}
    //
    // These flow uniformly from every provider that supports prompt caching:
    //   - OpenAI (gpt-5.4, gpt-4.1-mini): AUTOMATIC server-side caching for
    //     >1024 token prefixes, no markers needed. Returns cached_tokens.
    //   - Anthropic (claude-*): EXPLICIT cache_control markers required (we
    //     set them in buildSystemForDecide). Returns cache_read_input_tokens.
    //   - ZAI / GLM (zai-coding-plan via OpenAI-compatible endpoint): AUTOMATIC
    //     server-side caching, returns cached_tokens in prompt_tokens_details.
    //   - Google Gemini: explicit `cachedContent` ID-based caching (different
    //     paradigm — not currently exercised).
    //
    // The unified inputTokenDetails fields mean we get cache observability
    // for free across providers without per-provider extraction code.
    const inputDetails = result.usage?.inputTokenDetails as
      | { cacheReadTokens?: number | null; cacheWriteTokens?: number | null }
      | undefined;
    let cacheReadInputTokens = typeof inputDetails?.cacheReadTokens === 'number'
      ? inputDetails.cacheReadTokens
      : undefined;
    let cacheCreationInputTokens = typeof inputDetails?.cacheWriteTokens === 'number'
      ? inputDetails.cacheWriteTokens
      : undefined;
    // Fallback: some providers expose cache stats only via providerMetadata.
    // Anthropic uses cacheReadInputTokens / cacheCreationInputTokens directly,
    // OpenAI sometimes lands cached_tokens under providerMetadata.openai.
    if (cacheReadInputTokens === undefined || cacheCreationInputTokens === undefined) {
      const meta = result.providerMetadata as Record<string, Record<string, unknown>> | undefined;
      const anthropicMeta = meta?.anthropic;
      const openaiMeta = meta?.openai;
      if (cacheReadInputTokens === undefined) {
        const fromAnthropic = typeof anthropicMeta?.cacheReadInputTokens === 'number'
          ? (anthropicMeta.cacheReadInputTokens as number)
          : undefined;
        const fromOpenAI = typeof openaiMeta?.cachedPromptTokens === 'number'
          ? (openaiMeta.cachedPromptTokens as number)
          : undefined;
        cacheReadInputTokens = fromAnthropic ?? fromOpenAI;
      }
      if (cacheCreationInputTokens === undefined) {
        const fromAnthropic = typeof anthropicMeta?.cacheCreationInputTokens === 'number'
          ? (anthropicMeta.cacheCreationInputTokens as number)
          : undefined;
        cacheCreationInputTokens = fromAnthropic;
      }
    }

    return {
      text: result.text,
      tokensUsed: result.usage?.totalTokens,
      inputTokens: result.usage?.inputTokens ?? undefined,
      outputTokens: result.usage?.outputTokens ?? undefined,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    };
  }

  /**
   * Classify whether this turn should use the nav (cheap) model for decide().
   *
   * Empirically tested: routing early navigation turns to gpt-4.1-mini causes
   * worse decisions that cascade into longer runs (more turns = more total cost).
   * gpt-5.4 without routing is cheaper overall because it navigates more efficiently.
   *
   * Current strategy: nav model is ONLY used for verification (see verifyGoalCompletion),
   * not for decide(). The flag is kept for future experiments with better routing signals.
   */
  private shouldUseNavigationModel(
    _state: PageState,
    _extraContext?: string,
    _turnInfo?: { current: number; max: number },
  ): boolean {
    // Disabled for decide() — primary model is more cost-effective overall.
    // Verification still routes to nav model (separate code path).
    return false;
  }

  /**
   * Build the system prompt dynamically, injecting conditional rule groups
   * based on goal text, page snapshot content, and turn number.
   * Saves ~800 tokens per turn on simple navigation tasks.
   */
  private buildSystemPrompt(goal: string, state: PageState, turn: number): string {
    return this.composeSystemPromptParts(goal, state, turn).join('')
  }

  /**
   * Same as buildSystemPrompt but returns the parts so the caller can decide
   * how to send them. For Anthropic, decide() ships them as a SystemModelMessage[]
   * with cache_control on the stable CORE_RULES prefix; other providers join.
   *
   * The first slot is ALWAYS CORE_RULES (or the user's custom override) so the
   * cache breakpoint placement is deterministic. Extension-supplied rules are
   * appended AFTER REASONING_SUFFIX so the cached prefix stays byte-stable
   * across turns.
   */
  private composeSystemPromptParts(goal: string, state: PageState, turn: number): string[] {
    if (this.systemPrompt !== SYSTEM_PROMPT) return [this.systemPrompt]

    const parts: string[] = [CORE_RULES]
    const snapshotSample = state.snapshot.length > 4000 ? state.snapshot.slice(0, 4000) : state.snapshot
    if (SEARCH_SNAPSHOT_PATTERN.test(snapshotSample) || /\/search\b/i.test(state.url)) {
      parts.push(SEARCH_RULES)
      if (this.extensionRules?.search) {
        parts.push(`\n\nUSER RULES (search):\n${this.extensionRules.search}`)
      }
    }
    if (DATA_EXTRACTION_PATTERN.test(goal)) {
      parts.push(DATA_EXTRACTION_RULES)
      if (this.extensionRules?.dataExtraction) {
        parts.push(`\n\nUSER RULES (data extraction):\n${this.extensionRules.dataExtraction}`)
      }
    }
    if (state.snapshot.length > 10_000 || turn > 10) {
      parts.push(HEAVY_PAGE_RULES)
      if (this.extensionRules?.heavy) {
        parts.push(`\n\nUSER RULES (heavy page):\n${this.extensionRules.heavy}`)
      }
    }
    parts.push(REASONING_SUFFIX)

    // Global user rules + matching per-domain rules. Both are appended AFTER
    // REASONING_SUFFIX so they don't pollute the byte-stable cached prefix.
    if (this.extensionRules?.global) {
      parts.push(`\n\nUSER RULES (global):\n${this.extensionRules.global}`)
    }
    if (this.extensionDomainRules) {
      const domainRules = this.matchDomainRules(state.url)
      if (domainRules) {
        parts.push(`\n\nUSER RULES (domain match):\n${domainRules}`)
      }
    }
    return parts
  }

  /**
   * Find the per-domain extra rules whose domain key matches the URL host.
   * Multiple matches are concatenated in registration order.
   */
  private matchDomainRules(url: string): string | undefined {
    if (!this.extensionDomainRules) return undefined
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return undefined
    }
    const matches: string[] = []
    for (const [domain, rules] of Object.entries(this.extensionDomainRules)) {
      if (host.includes(domain) && rules.extraRules) {
        matches.push(rules.extraRules)
      }
    }
    return matches.length > 0 ? matches.join('\n\n') : undefined
  }

  /**
   * Inject extension-supplied rules. Called by the runner after loading
   * `bad.config.{js,mjs,ts}`. Pass undefined to clear.
   */
  setExtensionRules(
    sectionRules?: { global?: string; search?: string; dataExtraction?: string; heavy?: string },
    domainRules?: Record<string, { extraRules?: string }>,
  ): void {
    this.extensionRules = sectionRules
    this.extensionDomainRules = domainRules
  }

  /**
   * Build the system prompt for `decide()` in the form best suited to the
   * active provider:
   *   - Anthropic: a SystemModelMessage[] with `cache_control: ephemeral`
   *     on the CORE_RULES slot. Subsequent turns get a cache hit on the
   *     ~1500-token prefix (90% cheaper input + faster TTFT).
   *   - Everything else: a single concatenated string (current behavior).
   *
   * Custom system prompts (set via config) are passed verbatim — caching
   * is opt-in via the default prompt path only.
   */
  private buildSystemForDecide(
    goal: string,
    state: PageState,
    turn: number,
    providerName: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan',
  ): string | SystemModelMessage[] {
    const parts = this.composeSystemPromptParts(goal, state, turn)
    if (providerName !== 'anthropic' || this.systemPrompt !== SYSTEM_PROMPT || parts.length === 0) {
      return parts.join('')
    }
    // Anthropic path: first slot is CORE_RULES (cached), remaining parts ship
    // as a separate uncached system message so the prefix stays byte-stable
    // across turns and the cache hits.
    const corePart: SystemModelMessage = {
      role: 'system',
      content: parts[0],
      providerOptions: {
        anthropic: {
          cacheControl: { type: 'ephemeral' },
        },
      },
    }
    if (parts.length === 1) return [corePart]
    return [corePart, { role: 'system', content: parts.slice(1).join('') }]
  }

  /** Reset conversation history (call between scenarios) */
  reset(): void {
    this.history = [];
  }

  /**
   * Pre-warm the provider connection: instantiate the model client and fire a
   * tiny generateText so DNS+TLS+HTTP/2 keep-alive are established BEFORE
   * turn 1's decide call. Without this, turn 1's first LLM call eats 600ms
   * (Anthropic) to 1200ms (OpenAI) of cold-start that has nothing to do with
   * model latency.
   *
   * Cost: ~1 input token + 1 output token per run (negligible). Skips
   * silently for CLI-spawning providers (claude-code, codex-cli) where
   * connection warmup doesn't apply, and for sandbox-backend.
   *
   * Disable via BAD_NO_WARMUP=1 if a provider rejects 1-token calls.
   */
  async warmup(): Promise<void> {
    if (process.env.BAD_NO_WARMUP === '1') return;
    if (
      this.provider === 'codex-cli'
      || this.provider === 'claude-code'
      || this.provider === 'sandbox-backend'
    ) {
      return;
    }
    try {
      const model = await this.getModel();
      // 1-token "ping" — provider charges for the input but it's the cheapest
      // possible request shape. Errors are swallowed; warmup is best-effort.
      await generateText({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        ...this.generationOptions(1),
        abortSignal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    } catch {
      // Best-effort: any failure here just means turn 1 pays the cold-start.
    }
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
   * from older observations, keeping the last 2 user messages intact.
   *
   * For older turns, replaces the full ELEMENTS block with a one-line
   * summary showing element count and the selectors the agent actually
   * used, extracted from the paired assistant response.
   */
  private compactHistory(): ModelMessage[] {
    if (this.history.length === 0) return [];

    // Find indices of the last 2 user messages to keep intact
    const userIndices: number[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === 'user') {
        userIndices.push(i);
        if (userIndices.length === 2) break;
      }
    }
    const keepIntactFrom = userIndices.length > 0
      ? userIndices[userIndices.length - 1]
      : this.history.length;

    // Three-tier compression:
    //   Zone 1 (intact):         last 2 turns — full content
    //   Zone 2 (standard):       turns 3-5 back — ELEMENTS stripped from user msgs
    //   Zone 3 (deep compact):   turns 6+ back — both user and assistant ultra-compacted
    const deepCompactBefore = Math.max(0, this.history.length - 10);

    return this.history.map((msg, idx) => {
      // Zone 1: keep recent turns intact
      if (idx >= keepIntactFrom) return msg;

      // Zone 3: ultra-compact for very old messages (user + assistant)
      if (idx < deepCompactBefore) {
        if (msg.role === 'assistant') {
          const raw = typeof msg.content === 'string' ? msg.content : '';
          return { ...msg, content: this.deepCompactAssistant(raw) } as ModelMessage;
        }
        if (msg.role === 'user') {
          return { ...msg, content: this.deepCompactUser(msg) } as ModelMessage;
        }
        return msg;
      }

      // Zone 2: standard compact — strip ELEMENTS from user messages only
      if (msg.role !== 'user') return msg;

      const assistantMsg = idx + 1 < this.history.length ? this.history[idx + 1] : undefined;
      const selectors = assistantMsg?.role === 'assistant'
        ? this.extractSelectorsFromResponse(
            typeof assistantMsg.content === 'string' ? assistantMsg.content : '',
          )
        : [];

      // Handle multimodal content (array of parts)
      if (Array.isArray(msg.content)) {
        const compacted = msg.content
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map((part) => ({
            ...part,
            text: this.summarizeElements(part.text, selectors),
          }));
        return { ...msg, content: compacted } as ModelMessage;
      }

      // Handle string content
      if (typeof msg.content === 'string') {
        return { ...msg, content: this.summarizeElements(msg.content, selectors) } as ModelMessage;
      }

      return msg;
    });
  }

  private deepCompactUser(msg: ModelMessage): string {
    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
        : '';
    const urlMatch = text.match(/URL:\s*(\S+)/);
    const titleMatch = text.match(/Title:\s*(.+?)(?:\n|$)/);
    const url = urlMatch?.[1] ?? 'unknown';
    const title = titleMatch?.[1]?.slice(0, 80) ?? '';
    return `[Prior turn — URL: ${url}${title ? ` | ${title}` : ''}]`;
  }

  private deepCompactAssistant(raw: string): string {
    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      const action = parsed.action?.action ?? 'unknown';
      const selector = parsed.action?.selector ?? '';
      const parts = [action];
      if (selector) parts.push(selector);
      if (parsed.action?.url) parts.push(parsed.action.url.slice(0, 120));
      return `[${parts.join(' → ')}]`;
    } catch {
      return raw.slice(0, 100) + (raw.length > 100 ? '…' : '');
    }
  }

  /**
   * Extract @ref selectors from an assistant JSON response.
   */
  private extractSelectorsFromResponse(raw: string): string[] {
    const selectors: string[] = [];
    try {
      let text = raw.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const parsed = JSON.parse(text);
      if (parsed.action?.selector) selectors.push(parsed.action.selector);
      if (Array.isArray(parsed.nextActions)) {
        for (const na of parsed.nextActions) {
          if (na?.selector) selectors.push(na.selector);
        }
      }
    } catch {
      // Best effort
    }
    return selectors;
  }

  /**
   * Replace the ELEMENTS block with a one-line action-only summary.
   */
  private summarizeElements(text: string, selectors: string[]): string {
    return text.replace(
      /ELEMENTS[^:\n]*:\n[\s\S]*?(?=\n\n|What action should you take\?|$)/,
      (match) => {
        const snapshotStart = match.indexOf('\n');
        if (snapshotStart === -1) return 'ELEMENTS:\n[previous snapshot]';
        const snapshotText = match.slice(snapshotStart + 1);
        const elementCount = (snapshotText.match(/\[ref=\w+\]/g) || []).length;
        const selectorList = selectors.length > 0
          ? selectors.join(', ')
          : 'none';
        return `ELEMENTS:\n[Page snapshot: ${elementCount} elements | agent used: ${selectorList}]`;
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
    const samePageAsPrevious = this.lastDecisionUrl === state.url;
    const isFirstTurn = !turnInfo || turnInfo.current <= 1;

    // Diff-only mode: on same-page turns with small diffs, send only changed
    // elements instead of the full snapshot. Saves 40-80% of input tokens on
    // form-fill / interaction-heavy pages where the page structure is stable.
    const rawDiff = state.snapshotDiffRaw;
    const diffChanges = rawDiff ? rawDiff.added.length + rawDiff.removed.length + rawDiff.changed.length : 0;
    const diffTotal = rawDiff ? diffChanges + rawDiff.unchangedCount : 0;
    const useDiffOnly = samePageAsPrevious
      && !isFirstTurn
      && rawDiff !== undefined
      && diffChanges > 0
      && diffTotal > 0
      && diffChanges / diffTotal < 0.3;

    // Tighter snapshot budget on same-page turns — agent already saw the full page
    const snapshotBudget = samePageAsPrevious ? 8_000 : 16_000;
    let visibleSnapshot: string;
    let elementsHeader: string;
    if (useDiffOnly) {
      // Build compact diff-only view: changed/added elements with refs
      const lines: string[] = [];
      if (rawDiff!.added.length) lines.push('ADDED:', ...rawDiff!.added);
      if (rawDiff!.changed.length) lines.push('CHANGED:', ...rawDiff!.changed);
      if (rawDiff!.removed.length) lines.push('REMOVED:', ...rawDiff!.removed);
      lines.push(`(${rawDiff!.unchangedCount} elements unchanged — refs from previous turn still valid)`);
      visibleSnapshot = lines.join('\n');
      elementsHeader = 'ELEMENTS (diff-only, previous refs still valid)';
    } else {
      visibleSnapshot = useCompactFirstTurn
        ? compactFirstTurnSnapshot(state.snapshot)
        : budgetSnapshot(state.snapshot, snapshotBudget);
      elementsHeader = 'ELEMENTS';
    }
    this.lastDecisionUrl = state.url;

    // Build user message with stable prefix (GOAL) for prompt caching,
    // then dynamic per-turn content (turn budget, page state, elements).
    let textContent = `GOAL: ${goal}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

${elementsHeader}:
${visibleSnapshot}`;

    if (turnInfo) {
      const remaining = turnInfo.max - turnInfo.current;
      const budgetUsed = turnInfo.current / turnInfo.max;
      textContent += `\n\nTURN: ${turnInfo.current}/${turnInfo.max} (${remaining} remaining)`;
      if (remaining === 1) {
        textContent += ` — FINAL TURN: return a terminal action only (complete or abort)`;
      } else if (remaining <= 3) {
        textContent += ` — RUNNING LOW, avoid exploratory navigation; prioritize completing the goal or aborting with a clear blocker reason`;
      } else if (budgetUsed >= 0.5) {
        textContent += ` — HALF BUDGET USED. If you have extracted useful data, try completing now. Do not navigate away from pages with relevant content without attempting completion first`;
      }
    }

    // Append snapshot diff only when NOT using diff-only mode (avoid redundant info)
    if (!useDiffOnly && state.snapshotDiff && state.snapshotDiff.length < state.snapshot.length * 0.3) {
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
        console.log(`[Brain] Model route: ${mode} (${effectiveProvider}/${effectiveModel}) turn=${turnInfo?.current}/${turnInfo?.max}`);
      }
    }

    const messages: ModelMessage[] = [
      ...this.compactHistory(),
      { role: 'user', content: userContent },
    ];

    const dynamicSystemPrompt: string | SystemModelMessage[] = useCompactFirstTurn
      ? FIRST_TURN_COMPACT_PROMPT
      : this.buildSystemForDecide(goal, state, turnInfo?.current ?? 1, effectiveProvider)

    const modelOpts = { provider: effectiveProvider, model: effectiveModel };
    // Bump output budget near max turns so data-heavy completions don't truncate
    const nearingEnd = turnInfo && turnInfo.current >= turnInfo.max - 3;
    const maxTokens = useCompactFirstTurn ? 500 : nearingEnd ? 1200 : 600;
    const result = await this.generate(dynamicSystemPrompt, messages, modelOpts, maxTokens);

    let raw = result.text;
    let tokensUsed = result.tokensUsed;
    let inputTokens = result.inputTokens;
    let outputTokens = result.outputTokens;
    let cacheReadInputTokens = result.cacheReadInputTokens;
    let cacheCreationInputTokens = result.cacheCreationInputTokens;

    if (!raw) {
      throw new Error('Brain.decide: LLM returned empty response — possible rate limit or model error');
    }

    if (this.debug) {
      console.log('[Brain] Response:', raw.slice(0, 300));
    }

    let parsed = this.parse(raw);

    // On malformed JSON, retry with minimal context (current page + correction
    // hint) instead of burning a full turn. Costs ~7K tokens vs ~25K for a
    // full-history retry on the next turn.
    if (parsed.reasoning?.startsWith('Malformed LLM JSON response') && !useCompactFirstTurn) {
      if (this.debug) {
        console.log('[Brain] Malformed JSON — retrying with format hint');
      }
      const retryMessages: ModelMessage[] = [
        { role: 'user', content: userContent },
        { role: 'assistant', content: raw },
        { role: 'user', content: 'Your previous response was not valid JSON. Respond with ONLY a valid JSON object matching the required schema.' },
      ];
      try {
        const retryResult = await this.generate(dynamicSystemPrompt, retryMessages, modelOpts, maxTokens);
        if (retryResult.text) {
          const retryParsed = this.parse(retryResult.text);
          if (!retryParsed.reasoning?.startsWith('Malformed LLM JSON response')) {
            raw = retryResult.text;
            parsed = retryParsed;
          }
          tokensUsed = (tokensUsed ?? 0) + (retryResult.tokensUsed ?? 0);
          inputTokens = (inputTokens ?? 0) + (retryResult.inputTokens ?? 0);
          outputTokens = (outputTokens ?? 0) + (retryResult.outputTokens ?? 0);
          if (retryResult.cacheReadInputTokens !== undefined) {
            cacheReadInputTokens = (cacheReadInputTokens ?? 0) + retryResult.cacheReadInputTokens;
          }
          if (retryResult.cacheCreationInputTokens !== undefined) {
            cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + retryResult.cacheCreationInputTokens;
          }
        }
      } catch {
        // Retry failed — fall through with original wait(1000) fallback
      }
    }

    // Store in history
    this.history.push({ role: 'user', content: userContent });
    this.history.push({ role: 'assistant', content: raw });

    // Trim old history
    const maxMessages = this.maxHistoryTurns * 2;
    if (this.history.length > maxMessages) {
      this.history = this.history.slice(-maxMessages);
    }

    return {
      ...parsed,
      raw,
      tokensUsed,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      modelUsed: effectiveModel,
    };
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
    // Scout only needs candidates + context, not the full snapshot (saves 2-8k tokens)
    const lines = [
      `GOAL: ${goal}`,
      '',
      `PAGE: ${state.url} — ${state.title}`,
      '',
      'CANDIDATES:',
      ...topCandidates.map((candidate, index) =>
        `${index + 1}. ${candidate.ref} — ${candidate.text} (score ${candidate.score})`,
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
${budgetSnapshot(state.snapshot)}${siteBoundaryNote ? `\n\n${siteBoundaryNote}` : ''}

Was the goal actually achieved? Analyze the current page state carefully.`;

    const userContent = this.buildUserContent(textContent, state.screenshot, true);

    // Verification is a structured yes/no task — use nav model if available
    const verifyProvider = this.adaptiveModelRouting && this.navModelName
      ? (this.navProvider || this.provider)
      : undefined;
    const verifyModel = this.adaptiveModelRouting && this.navModelName
      ? this.navModelName
      : undefined;

    const result = await this.generate(
      `Verify whether the browser agent achieved its goal. Respond with ONLY JSON:
{"achieved":true,"confidence":0.9,"evidence":["observation"],"missing":[]}

Check: page state matches goal, no errors, URL is expected, claimed result matches visible data.
SUPPLEMENTAL TOOL EVIDENCE / SCRIPT RESULT in claimed results = verified DOM data, trustworthy even if page navigated away. Multi-page data collection is valid.`,
      [{ role: 'user', content: userContent }],
      verifyProvider && verifyModel ? { provider: verifyProvider, model: verifyModel } : undefined,
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
    checkpoints: string[],
    systemPrompt?: string,
  ): Promise<{ score: number; findings: DesignFinding[]; raw: string; tokensUsed?: number; designSystemScore?: Record<string, unknown> }> {
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
      systemPrompt ?? DESIGN_AUDIT_PROMPT,
      [{ role: 'user', content: userContent }],
      undefined,
      8000,
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
      // Extract JSON object if surrounded by non-JSON text or truncated
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
          parsed = JSON.parse(text.slice(start, end + 1));
        } else {
          throw new Error('No JSON object found');
        }
      }

      const VALID_CATEGORIES = new Set(['visual-bug', 'layout', 'contrast', 'alignment', 'spacing', 'typography', 'accessibility', 'ux']);
      const VALID_SEVERITIES = new Set(['critical', 'major', 'minor']);

      const VALID_BLAST = new Set(['page', 'section', 'component', 'system']);
      const clampScore = (n: unknown): number | undefined =>
        typeof n === 'number' ? Math.max(1, Math.min(10, n)) : undefined;

      const findings: DesignFinding[] = Array.isArray(parsed.findings)
        ? parsed.findings.map((f: Record<string, unknown>) => ({
            category: (VALID_CATEGORIES.has(f.category as string) ? f.category : 'ux') as DesignFinding['category'],
            severity: (VALID_SEVERITIES.has(f.severity as string) ? f.severity : 'minor') as DesignFinding['severity'],
            description: String(f.description ?? ''),
            location: String(f.location ?? ''),
            suggestion: String(f.suggestion ?? ''),
            ...(f.cssSelector ? { cssSelector: String(f.cssSelector) } : {}),
            ...(f.cssFix ? { cssFix: String(f.cssFix) } : {}),
            // Gen 3 ROI fields
            ...(clampScore(f.impact) !== undefined ? { impact: clampScore(f.impact) } : {}),
            ...(clampScore(f.effort) !== undefined ? { effort: clampScore(f.effort) } : {}),
            ...(VALID_BLAST.has(f.blast as string)
              ? { blast: f.blast as DesignFinding['blast'] }
              : {}),
          }))
        : [];

      const designSystemScore = parsed.designSystemScore && typeof parsed.designSystemScore === 'object'
        ? parsed.designSystemScore as Record<string, unknown>
        : undefined;

      const rawScore = typeof parsed.score === 'number' ? parsed.score : 5;
      return {
        score: Math.max(1, Math.min(10, rawScore)),
        findings,
        raw,
        tokensUsed,
        designSystemScore,
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

  /**
   * Generic text-completion entry point for non-agent uses (GEPA reflective
   * mutation, ad-hoc rubric authoring, knowledge distillation). Returns the
   * raw text + token usage; callers parse JSON themselves.
   *
   * No tool use, no decode-loop heuristics — just a single round-trip through
   * the configured provider/model.
   */
  async complete(
    system: string,
    user: string,
    options: { maxOutputTokens?: number } = {},
  ): Promise<{ text: string; tokensUsed?: number }> {
    const result = await this.generate(
      system,
      [{ role: 'user', content: user }],
      undefined,
      options.maxOutputTokens ?? 1500,
    );
    return { text: result.text, tokensUsed: result.tokensUsed };
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
      'fill', 'clickSequence',
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

/**
 * Collapse consecutive runs of similar elements (same indent + role, names
 * differing only by a trailing number/short suffix) into a single representative
 * line with a count.  Reduces token cost on pages with long pagination, nav
 * lists, or repeated product cards.
 *
 * Skips dialog/alertdialog (agent must see each one) and groups < 3 items.
 */
function deduplicateSnapshot(snapshot: string): string {
  const lines = snapshot.split('\n')
  const out: string[] = []

  // Extract (indent, role) from a snapshot line. Returns null for non-element lines.
  const parseLine = (line: string) => {
    const m = line.match(/^(\s*-\s+)(\w+)\s+"([^"]*)"\s*\[ref=(\w+)\]/)
    if (!m) return null
    return { indent: m[1], role: m[2], name: m[3], ref: m[4], full: line }
  }

  // Strip trailing numbers/ordinals to get a "name stem" for grouping.
  // "Page 1" and "Page 20" → "Page ", "Item #3" and "Item #42" → "Item #"
  const nameStem = (name: string): string =>
    name.replace(/\d+/g, '#')

  let i = 0
  while (i < lines.length) {
    const parsed = parseLine(lines[i])

    // Non-element line or dialog/alertdialog — emit as-is
    if (!parsed || /\b(?:dialog|alertdialog)\b/i.test(parsed.role)) {
      out.push(lines[i])
      i++
      continue
    }

    // Collect a consecutive run of same (indent, role) with similar name stems
    const group: NonNullable<ReturnType<typeof parseLine>>[] = [parsed]
    const stem = nameStem(parsed.name)
    let j = i + 1
    while (j < lines.length) {
      const next = parseLine(lines[j])
      if (
        !next ||
        next.indent !== parsed.indent ||
        next.role !== parsed.role ||
        nameStem(next.name) !== stem
      ) break
      group.push(next)
      j++
    }

    if (group.length < 3) {
      // Not enough to dedup — emit originals
      for (const g of group) out.push(g.full)
    } else {
      // Emit first element with a summary of the rest
      const last = group[group.length - 1]
      out.push(`${parsed.full} (+${group.length - 1} similar: "${group[1].name}"\u2026"${last.name}")`)
    }
    i = j
  }

  return out.join('\n')
}

/**
 * Cap snapshot size for non-first turns to control token cost on large pages.
 * Keeps the full snapshot when it fits within budget; otherwise truncates
 * non-interactive decorative lines first, then hard-caps with a notice.
 */
function budgetSnapshot(snapshot: string, maxChars = 16_000): string {
  // Skip dedup on small snapshots — not enough repetition to justify the O(n) scan
  if (snapshot.length > 6_000) {
    snapshot = deduplicateSnapshot(snapshot)
  }

  if (snapshot.length <= maxChars) return snapshot;

  // First pass: drop non-interactive lines (images, paragraphs, decorative text)
  // to keep interactive elements (buttons, links, textboxes, headings).
  const lines = snapshot.split('\n');
  const interactive: string[] = [];
  const decorative: string[] = [];
  for (const line of lines) {
    if (/\b(?:button|link|textbox|combobox|menuitem|checkbox|radio|select|heading|dialog|alertdialog)\b/i.test(line) && /\[ref=/.test(line)) {
      interactive.push(line);
    } else {
      decorative.push(line);
    }
  }

  // If interactive-only fits, use it with a truncation note
  const interactiveText = interactive.join('\n');
  if (interactiveText.length <= maxChars) {
    return interactiveText + `\n... [${decorative.length} decorative elements omitted for brevity]`;
  }

  // Second pass: when interactive elements still exceed budget, prioritize:
  // 1. searchbox/textbox/combobox (inputs — essential for form tasks)
  // 2. headings (structural navigation)
  // 3. links/buttons (main content — keep all, trim from end as last resort)
  const priority: string[] = [];
  const bulk: string[] = [];
  for (const line of interactive) {
    if (/\b(?:searchbox|textbox|combobox|heading|dialog|alertdialog)\b/i.test(line)) {
      priority.push(line);
    } else {
      bulk.push(line);
    }
  }

  const priorityText = priority.join('\n');
  const remaining = maxChars - priorityText.length - 80; // reserve space for note
  if (remaining > 0) {
    const bulkText = bulk.join('\n');
    const trimmedBulk = bulkText.slice(0, remaining);
    const bulkKept = trimmedBulk.lastIndexOf('\n') > 0
      ? trimmedBulk.slice(0, trimmedBulk.lastIndexOf('\n'))
      : trimmedBulk;
    return priorityText + '\n' + bulkKept +
      `\n... [${interactive.length - priority.length - bulkKept.split('\n').length} interactive + ${decorative.length} decorative elements omitted]`;
  }

  // Hard cap: take the first maxChars of the full snapshot
  return snapshot.slice(0, maxChars) + '\n... [snapshot truncated — large page]';
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
    case 'fill': {
      // Multi-field batch fill — at least one of fields/selects/checks must be non-empty
      const fields = isStringRecord(data.fields) ? data.fields : undefined;
      const selects = isStringRecord(data.selects) ? data.selects : undefined;
      const checks = Array.isArray(data.checks) && data.checks.every((c) => typeof c === 'string')
        ? (data.checks as string[])
        : undefined;
      const fieldCount = (fields ? Object.keys(fields).length : 0)
        + (selects ? Object.keys(selects).length : 0)
        + (checks ? checks.length : 0);
      if (fieldCount === 0) {
        throw new Error('fill action requires at least one of "fields" (object), "selects" (object), or "checks" (string[])');
      }
      return {
        action: 'fill',
        ...(fields ? { fields } : {}),
        ...(selects ? { selects } : {}),
        ...(checks ? { checks } : {}),
      };
    }
    case 'clickSequence': {
      const refs = Array.isArray(data.refs) && data.refs.every((r) => typeof r === 'string')
        ? (data.refs as string[])
        : null;
      if (!refs || refs.length === 0) {
        throw new Error('clickSequence action requires "refs" (string[]) with at least one entry');
      }
      return {
        action: 'clickSequence',
        refs,
        ...(typeof data.intervalMs === 'number' ? { intervalMs: data.intervalMs } : {}),
      };
    }
    default:
      throw new Error(`Unknown action type: ${actionType}`);
  }
}

/** Type guard: value is a Record<string, string> */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}
