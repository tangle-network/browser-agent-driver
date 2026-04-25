/**
 * Fleet telemetry envelope.
 *
 * One envelope per meaningful unit of work — a page audit, an evolve round, a
 * full bad run. Envelopes are append-only and JSONL-friendly. Schema is
 * deliberately a superset of agent-eval's Run/Span trace shape so a future
 * rollup script can promote these into agent-eval traces without translation.
 *
 * Versioning: bump `schemaVersion` only when readers must change. Adding
 * optional fields is backwards-compatible and does not require a bump.
 */

export const TELEMETRY_SCHEMA_VERSION = 1

/** Discriminator for the high-level invocation that produced this envelope. */
export type TelemetryKind =
  | 'design-audit-page'   // one page through the full audit pipeline
  | 'design-audit-run'    // a `bad design-audit` invocation, summarising N pages
  | 'design-evolve-round' // one round of CSS- or agent-evolve
  | 'design-evolve-run'   // an evolve invocation, summarising rounds
  | 'agent-run'           // a `bad run` agent invocation (run-level)
  | 'gepa-trial'          // one prompt-variant evaluation inside the GEPA loop
  | 'gepa-generation'     // one generation summary

export interface TelemetryEnvelope {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  /** Unique id for this envelope. */
  envelopeId: string
  /** Groups envelopes from a single CLI invocation. */
  runId: string
  /** When this envelope was finalised. */
  timestamp: string
  /** Optional: link a child envelope (e.g. one page) to a parent run envelope. */
  parentRunId?: string

  source: TelemetrySource
  model?: TelemetryModel
  kind: TelemetryKind
  ok: boolean
  durationMs: number

  /**
   * Kind-specific payload. Stays loose on purpose — readers query by `kind` and
   * key into `data`. Keep shapes flat and JSON-serialisable; large blobs
   * (screenshots, full snapshots) belong on disk in the run's sink, not here.
   */
  data: Record<string, unknown>

  /**
   * Numeric metrics suitable for aggregation: scores, counts, durations, costs.
   * Kept separate from `data` so a rollup can sum/avg without schema awareness.
   */
  metrics: Record<string, number>

  /** Free-form labels for filtering during rollup. */
  tags?: Record<string, string>

  /** Populated only when `ok === false`. */
  error?: string
}

export interface TelemetrySource {
  /** Repo identity — basename of cwd plus git remote if discoverable. */
  repo: string
  cwd: string
  gitSha?: string
  gitBranch?: string
  cliVersion: string
  /** What was invoked, e.g. `design-audit`, `design-audit --evolve`, `run`. */
  invocation: string
  /** Sanitised argv minus secrets. */
  argv?: string[]
  /**
   * Multi-tenant identity. Set when the CLI runs inside a hosted product
   * (bad-app, agent-platform) so a fleet rollup can group by tenant without
   * leaking customer URLs or PII. The host populates this via
   * `BAD_TENANT_ID` env var when it spawns the sandbox.
   */
  tenantId?: string
  /**
   * Optional sub-tenant identity (project, suite, walkthrough, customer).
   * Convention: opaque string the host can map back to its own entities.
   */
  customerId?: string
  /**
   * SHA-256 (12 hex) of the API key used to authenticate this run, when the
   * host supplies one. Lets a rollup attribute usage to a key without
   * holding the key itself. Set via `BAD_API_KEY_HASH` env var.
   */
  apiKeyHash?: string
}

export interface TelemetryModel {
  provider: string
  name: string
  /** SHA-256 (12 hex chars) of the prompt(s) used. Lets a rollup correlate
   *  outcome shifts to specific prompt versions. */
  promptHash?: string
  /** SHA-256 (12 hex chars) of the composed rubric body if applicable. */
  rubricHash?: string
}
