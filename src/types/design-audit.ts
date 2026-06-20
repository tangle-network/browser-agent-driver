// ============================================================================
// Design Audit Types
// ============================================================================

export interface DesignFinding {
  category: 'visual-bug' | 'layout' | 'contrast' | 'alignment' | 'spacing' | 'typography' | 'accessibility' | 'ux';
  severity: 'critical' | 'major' | 'minor';
  description: string;
  location: string;
  suggestion: string;
  /** CSS selector targeting the element to fix */
  cssSelector?: string;
  /** Concrete CSS property:value fix */
  cssFix?: string;
  // ── ROI fields ──────────────────────────────────────────────────────
  /** 1-10: how much this hurts the user experience */
  impact?: number;
  /** 1-10: how hard the fix is (1 = trivial CSS change, 10 = architectural rework) */
  effort?: number;
  /** Scope of the fix's effect — page-specific, section-specific, component-level, or design-system-wide */
  blast?: 'page' | 'section' | 'component' | 'system';
  /** Computed: (impact * blastWeight) / effort. Higher = fix this first. */
  roi?: number;
  /** Number of audited pages where this finding (or its dedupe-equivalent) appears */
  pageCount?: number;
  /**
   * Layer 2 — raw LLM-emitted patches, if any. Untyped here to keep the v1
   * shape free of audit-internal types. The Layer 2 parser in
   * src/design/audit/patches/parse.ts validates and converts to typed Patches
   * before they land on the canonical AuditResult.
   */
  rawPatches?: unknown[];
}

export interface DesignSystemScore {
  layout: number;
  typography: number;
  color: number;
  spacing: number;
  components: number;
  interactions: number;
  accessibility: number;
  polish: number;
}

export interface DesignEvolveResult {
  /** Initial audit score */
  beforeScore: number;
  /** Score after applying fixes */
  afterScore: number;
  /** Score delta (positive = improvement) */
  delta: number;
  /** Rounds of fix-reaudit cycles completed */
  rounds: number;
  /** Fixes that were applied */
  appliedFixes: Array<{ cssSelector: string; cssFix: string; finding: string }>;
  /** Fixes that were generated but not applied */
  skippedFixes: Array<{ cssSelector: string; cssFix: string; reason: string }>;
  /** Per-round scores for convergence tracking */
  scoreHistory: number[];
  /** Generated CSS override stylesheet */
  cssOverride: string;
}

export interface FlowAuditResult {
  flow: string;
  steps: number;
  reachedGoal: boolean;
  findings: DesignFinding[];
  screenshots: string[];
  score: number;
  error?: string;
}

export interface DesignAuditReport {
  timestamp: string;
  flows: FlowAuditResult[];
  summary: {
    healthScore: number;
    totalFindings: number;
    critical: number;
    major: number;
    minor: number;
  };
}

export interface AuditFlow {
  name: string;
  startUrl: string;
  goal: string;
  checkpoints: string[];
  maxTurns?: number;
}
