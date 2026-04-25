/**
 * Goal Decomposer — detects compound goals and splits them into
 * parallel-executable sub-goals.
 *
 * Gen 21: the intelligence layer for parallel tab exploration.
 * One cheap LLM call classifies the goal and splits if needed.
 * Conservative by default — only splits when the pattern is clear.
 */

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import {
  resolveProviderApiKey,
  resolveProviderModelName,
} from '../provider-defaults.js'

export interface SubGoal {
  /** The sub-goal description */
  goal: string
  /** Optional start URL for this sub-goal (defaults to parent's startUrl) */
  startUrl?: string
  /** Fraction of total budget for this sub-goal (0-1, must sum to ≤1) */
  budgetFraction: number
}

export interface DecompositionResult {
  type: 'simple' | 'compound'
  /** Original goal (always present) */
  originalGoal: string
  /** Sub-goals (only when type === 'compound') */
  subGoals?: SubGoal[]
  /** Why the goal was classified this way */
  reasoning?: string
}

// Fast regex pre-filter — skip the LLM call entirely for obviously simple goals
const SIMPLE_PATTERNS = [
  /^(?:find|search|look up|open|navigate|go to|check|tell me)\b[^,]*$/i,
  /^what (?:is|are)\b/i,
  /^how (?:do|can|to)\b/i,
]

const COMPOUND_SIGNALS = [
  /\bcompare\b/i,
  /\bvs\.?\b|\bversus\b/i,
  /\band (?:also|then|additionally)\b/i,
  /\bfind (?:the )?\d+\b/i,
  /\blist (?:the )?\d+\b/i,
  /\btop \d+\b/i,
  /\b\d+ (?:different|separate|distinct)\b/i,
  /\bboth\b.*\band\b/i,
]

const DECOMPOSE_PROMPT = `You decide whether a web browsing goal should be split into parallel sub-tasks.

RULES:
- "compare X vs Y" → split into sub-tasks, one per item to compare
- "find N items matching criteria" → KEEP AS ONE task (the agent searches once and collects)
- "do X and also do Y" on different sites → split
- "do X and also do Y" on the same site → keep as one (sequential is fine)
- Simple extraction, navigation, or single-site tasks → always "simple"
- When in doubt, return "simple" — false splits waste resources

Respond with ONLY a JSON object:
{
  "type": "simple" | "compound",
  "reasoning": "one sentence why",
  "subGoals": [
    {"goal": "sub-goal description", "startUrl": "https://..." or null, "budgetFraction": 0.5}
  ]
}

subGoals is required only when type is "compound". budgetFractions must sum to 1.0.
Each sub-goal should be self-contained — the sub-agent won't see the other sub-goals.`

/**
 * Analyze a goal and decide whether to decompose it into parallel sub-goals.
 *
 * Uses a fast regex pre-filter to skip the LLM call for obviously simple goals.
 * Only calls the LLM when compound signals are detected.
 */
export async function decomposeGoal(
  goal: string,
  startUrl: string,
  options: {
    provider: string
    model?: string
    apiKey?: string
    baseUrl?: string
  },
): Promise<DecompositionResult> {
  // Fast path: obviously simple goals skip the LLM call
  if (SIMPLE_PATTERNS.some(p => p.test(goal)) && !COMPOUND_SIGNALS.some(p => p.test(goal))) {
    return { type: 'simple', originalGoal: goal, reasoning: 'simple pattern match' }
  }

  // No compound signals → simple
  if (!COMPOUND_SIGNALS.some(p => p.test(goal))) {
    return { type: 'simple', originalGoal: goal, reasoning: 'no compound signals' }
  }

  // LLM classification for ambiguous cases
  try {
    const provider = options.provider as 'openai' | 'anthropic' | 'google'
    const modelName = options.model || 'gpt-4.1-mini'
    const apiKey = options.apiKey || resolveProviderApiKey(provider)
    const resolvedModel = resolveProviderModelName(provider, modelName)

    // Dynamic import to avoid circular deps
    const providerMod = provider === 'anthropic'
      ? await import('@ai-sdk/anthropic')
      : provider === 'google'
        ? await import('@ai-sdk/google')
        : await import('@ai-sdk/openai')

    const createModel = 'createOpenAI' in providerMod
      ? (providerMod as { createOpenAI: (opts: { apiKey: string; baseURL?: string }) => { languageModel: (id: string) => LanguageModel } }).createOpenAI
      : 'createAnthropic' in providerMod
        ? (providerMod as { createAnthropic: (opts: { apiKey: string }) => { languageModel: (id: string) => LanguageModel } }).createAnthropic
        : (providerMod as { createGoogleGenerativeAI: (opts: { apiKey: string }) => { languageModel: (id: string) => LanguageModel } }).createGoogleGenerativeAI

    const client = createModel({
      apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    } as { apiKey: string; baseURL?: string })

    const model = client.languageModel(resolvedModel)

    const result = await generateText({
      model,
      system: DECOMPOSE_PROMPT,
      messages: [
        { role: 'user', content: `GOAL: ${goal}\nSTART URL: ${startUrl}` },
      ],
      maxOutputTokens: 300,
    })

    const raw = result.text.trim()
    const parsed = JSON.parse(raw.replace(/^```json\s*/, '').replace(/\s*```$/, ''))

    if (parsed.type === 'compound' && Array.isArray(parsed.subGoals) && parsed.subGoals.length >= 2) {
      const subGoals: SubGoal[] = parsed.subGoals.map((sg: { goal?: string; startUrl?: string; budgetFraction?: number }) => ({
        goal: String(sg.goal || ''),
        startUrl: sg.startUrl || startUrl,
        budgetFraction: Number(sg.budgetFraction) || (1 / parsed.subGoals.length),
      }))

      // Normalize budget fractions to sum to 1.0
      const totalBudget = subGoals.reduce((s, sg) => s + sg.budgetFraction, 0)
      if (totalBudget > 0) {
        for (const sg of subGoals) sg.budgetFraction /= totalBudget
      }

      return {
        type: 'compound',
        originalGoal: goal,
        subGoals,
        reasoning: parsed.reasoning || 'LLM classified as compound',
      }
    }

    return {
      type: 'simple',
      originalGoal: goal,
      reasoning: parsed.reasoning || 'LLM classified as simple',
    }
  } catch {
    // LLM call failed — fall back to simple (safe default)
    return { type: 'simple', originalGoal: goal, reasoning: 'decomposer error, defaulting to simple' }
  }
}
