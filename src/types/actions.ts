// ============================================================================
// Actions - What the agent can do
// ============================================================================

export interface ClickAction {
  action: 'click';
  selector: string;
}

export interface TypeAction {
  action: 'type';
  selector: string;
  text: string;
}

export interface ScrollAction {
  action: 'scroll';
  direction: 'up' | 'down';
  /** Scroll distance in pixels (default: 500) */
  amount?: number;
  /** Optional selector for scrolling a specific container (default: viewport) */
  selector?: string;
}

export interface NavigateAction {
  action: 'navigate';
  url: string;
}

export interface WaitAction {
  action: 'wait';
  ms: number;
}

export interface CompleteAction {
  action: 'complete';
  result: string;
}

export interface PressAction {
  action: 'press';
  selector: string;
  key: string;
}

export interface HoverAction {
  action: 'hover';
  selector: string;
}

export interface SelectAction {
  action: 'select';
  selector: string;
  value: string;
}

export interface EvaluateAction {
  action: 'evaluate';
  criteria: string;
}

export interface RunScriptAction {
  action: 'runScript';
  /** JavaScript expression to evaluate in page context */
  script: string;
}

/**
 * Extract a numbered, text-rich index of elements matching a CSS
 * selector. Returns the visible textContent + tag + key attributes + a stable
 * selector for each match. The agent then picks elements by index in the next
 * turn (e.g., complete with `result: extracted[3].text`).
 *
 * The agent gets a broad selector (e.g. `'p, span, dd, code'`) and reads the
 * actual text content of every match. Pick-by-content is more reliable than
 * selector-by-name on pages where data lives in `<dl>/<dt>/<dd>/<code>/<pre>`
 * or inside obscure wrapper divs.
 *
 * Example payload for npm weekly downloads:
 *   {
 *     action: 'extractWithIndex',
 *     query: 'p, span, strong',
 *     contains: 'downloads',
 *   }
 *
 * Optional `contains` filters matches to only those containing the substring
 * (case-insensitive). Without `contains`, all matches are returned (capped at
 * 80 to keep the response readable).
 */
export interface ExtractWithIndexAction {
  action: 'extractWithIndex';
  /** CSS selector — broad selectors are fine, the response includes full text per match */
  query: string;
  /** Optional substring filter (case-insensitive) applied to textContent */
  contains?: string;
}

export interface VerifyPreviewAction {
  action: 'verifyPreview';
}

export interface AbortAction {
  action: 'abort';
  reason: string;
}

/**
 * Multi-field form fill — fill N fields, select N dropdowns, and check N
 * checkboxes in a SINGLE action. Replaces the click+type+click+type pattern
 * that takes one turn per field.
 *
 * Example payload for a 5-field form:
 *   {
 *     action: 'fill',
 *     fields: { '@t1': 'Jordan', '@t2': 'Rivera', '@t3': 'jordan@example.com' },
 *     selects: { '@s1': 'WA' },
 *     checks: ['@c1', '@c2'],
 *   }
 *
 * Each entry runs in order. Failures bail with the first error and report
 * which field failed so the agent can recover by switching to single-step
 * actions on the next turn.
 */
export interface BatchFillAction {
  action: 'fill';
  /** Map of @ref → text value to type into each field */
  fields?: Record<string, string>;
  /** Map of @ref → option value or label for select dropdowns */
  selects?: Record<string, string>;
  /** Array of @refs to check (checkboxes / radios) */
  checks?: string[];
}

/**
 * Sequential clicks on a known set of refs. For multi-step UI navigation
 * where the agent has identified the click chain ahead of time (e.g., open
 * menu → click submenu → click item).
 *
 * Each click runs in order with an optional interval. Failures bail with
 * the first error.
 */
export interface ClickSequenceAction {
  action: 'clickSequence';
  /** Array of @refs to click in order */
  refs: string[];
  /** Optional wait between clicks in ms (default: 100) */
  intervalMs?: number;
}

// Vision-first coordinate-based actions.
export interface ClickAtAction {
  action: 'clickAt';
  /** X coordinate in virtual screen space (0-1024) */
  x: number;
  /** Y coordinate in virtual screen space (0-768) */
  y: number;
}

export interface TypeAtAction {
  action: 'typeAt';
  /** X coordinate in virtual screen space (0-1024) */
  x: number;
  /** Y coordinate in virtual screen space (0-768) */
  y: number;
  /** Text to type after clicking */
  text: string;
}

// Set-of-Marks label-based actions.
export interface ClickLabelAction {
  action: 'clickLabel';
  /** Label number from the SoM overlay (e.g., 3 for element [3]) */
  label: number;
}

export interface TypeLabelAction {
  action: 'typeLabel';
  /** Label number from the SoM overlay */
  label: number;
  /** Text to type after clicking */
  text: string;
}

/**
 * Invoke a named macro defined in `skills/macros/<name>.json`. The macro
 * expands into a sequence of existing primitive actions. The driver
 * executes each step in order; the first failure aborts the macro and its
 * error is surfaced as the macro's ActionResult error.
 *
 * Macros are flat (cannot call other macros) to keep dispatch bounded and
 * to avoid cycles. They receive arguments via `args`, which is substituted
 * into `${paramName}` placeholders in each step's string fields.
 */
export interface MacroAction {
  action: 'macro';
  /** Macro name, matches a registered MacroDefinition */
  name: string;
  /** Arguments to interpolate into the macro's steps. Optional when the
   *  macro has no declared parameters. */
  args?: Record<string, string>;
}

/**
 * Mid-run parallel fan-out. Spawns N sub-agents in fresh tabs,
 * each with its own URL + goal, collects the results as structured
 * feedback. Used when the agent sees "10 candidates, investigate each
 * in parallel" — search result fan-out, roster screening, N-way
 * comparison shopping, etc.
 *
 * Each sub-goal runs in an isolated tab sharing the parent context
 * (cookies, localStorage) but not the parent page's live state. Results
 * are merged and injected back as agent feedback so the outer goal
 * continues with the enriched data.
 */
export interface FanOutAction {
  action: 'fanOut';
  /**
   * Explicit sub-goals. Use when each branch needs a different URL
   * or fundamentally different instruction. Mutually exclusive with
   * the (baseUrl, goalTemplate, items) shorthand below.
   */
  subGoals?: Array<{
    /** Starting URL for this branch. */
    url: string;
    /** Natural-language goal for this branch. */
    goal: string;
    /** Human-readable label rendered in the overlay + feedback. */
    label?: string;
    /** Max turns for this sub-agent. Default: 8. */
    maxTurns?: number;
  }>;
  /**
   * Shorthand for batch-shaped fanOuts. Lets the agent emit a tiny JSON
   * object (one baseUrl, one template, an array of string items) that
   * the runtime expands into full subGoals. This is the PREFERRED shape
   * for N>3 branches — it keeps the LLM's JSON output minimal and
   * escape-free, which meaningfully improves reliability (long nested
   * subGoals arrays cause JSON parse failures in practice).
   *
   * Example:
   *   {
   *     "action": "fanOut",
   *     "baseUrl": "https://sanctionssearch.ofac.treas.gov/",
   *     "goalTemplate": "Screen {item} on OFAC SDN. Report CLEARED / POSITIVE MATCH with program / NEEDS REVIEW.",
   *     "items": ["SMITH JOHN", "MADURO NICOLAS", "AL-ASSAD BASHAR"]
   *   }
   *
   * Expanded to:
   *   subGoals: [
   *     { url: baseUrl, goal: "Screen SMITH JOHN on OFAC SDN. ...", label: "SMITH JOHN" },
   *     { url: baseUrl, goal: "Screen MADURO NICOLAS on OFAC SDN. ...", label: "MADURO NICOLAS" },
   *     ...
   *   ]
   *
   * `{item}` in goalTemplate is replaced with each array entry verbatim.
   * The label is the item itself.
   */
  baseUrl?: string;
  goalTemplate?: string;
  items?: string[];
  /**
   * Optional guidance on how to combine sub-results when they return.
   * Default: serialize as a JSON array with {label, verdict} entries.
   */
  summarize?: string;
}

export type Action =
  | ClickAction
  | TypeAction
  | PressAction
  | HoverAction
  | SelectAction
  | ScrollAction
  | NavigateAction
  | WaitAction
  | EvaluateAction
  | RunScriptAction
  | ExtractWithIndexAction
  | VerifyPreviewAction
  | CompleteAction
  | AbortAction
  | BatchFillAction
  | ClickSequenceAction
  | ClickAtAction
  | TypeAtAction
  | ClickLabelAction
  | TypeLabelAction
  | MacroAction
  | FanOutAction;
