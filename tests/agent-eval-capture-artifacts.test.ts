import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

async function loadHelper(): Promise<{
  configureAgentEvalCaptureEnv: (input: {
    childEnv: NodeJS.ProcessEnv
    mode: string
    rootDir: string
    scenarioId?: string
    candidateId?: string
  }) => { enabled: boolean; dir?: string; require?: boolean }
  inspectAgentEvalCaptureArtifacts: (
    dir: string,
    options?: { require?: boolean },
  ) => {
    passed: boolean
    rawProviderEvents: number
    traceRows: number
    failures: string[]
  }
}> {
  const helperPath = path.resolve(process.cwd(), 'scripts/lib/agent-eval-capture-artifacts.mjs')
  return import(pathToFileURL(helperPath).href)
}

describe('agent-eval capture artifact checks', () => {
  it('scopes benchmark child capture per mode and stamps stable run metadata', async () => {
    const { configureAgentEvalCaptureEnv } = await loadHelper()
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-capture-env-'))
    const childEnv: NodeJS.ProcessEnv = {
      BAD_AGENT_EVAL_CAPTURE_DIR: 'captures',
      BAD_AGENT_EVAL_CAPTURE_REQUIRE: '1',
    }

    const configured = configureAgentEvalCaptureEnv({
      childEnv,
      mode: 'full-evidence',
      rootDir,
      scenarioId: 'local-form-multistep',
      candidateId: 'baseline',
    })

    expect(configured).toEqual({
      enabled: true,
      dir: path.join(rootDir, 'captures', 'full-evidence'),
      require: true,
    })
    expect(childEnv.BAD_AGENT_EVAL_CAPTURE_DIR).toBe(path.join(rootDir, 'captures', 'full-evidence'))
    expect(childEnv.BAD_AGENT_EVAL_SCENARIO_ID).toBe('local-form-multistep')
    expect(childEnv.BAD_AGENT_EVAL_CANDIDATE_ID).toBe('baseline')
    expect(childEnv.BAD_AGENT_EVAL_RUN_ID).toBe('local-form-multistep-full-evidence')
  })

  it('fails strict smoke checks when raw provider capture is missing', async () => {
    const { inspectAgentEvalCaptureArtifacts } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-capture-missing-'))

    const check = inspectAgentEvalCaptureArtifacts(dir, { require: true })

    expect(check.passed).toBe(false)
    expect(check.rawProviderEvents).toBe(0)
    expect(check.traceRows).toBe(0)
    expect(check.failures).toEqual([
      `agent-eval capture emitted no raw-provider events in ${path.join(dir, 'raw-provider')}`,
      `agent-eval capture emitted no trace rows in ${path.join(dir, 'traces')}`,
    ])
  })

  it('passes strict smoke checks when raw provider and trace rows exist', async () => {
    const { inspectAgentEvalCaptureArtifacts } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-capture-present-'))
    fs.mkdirSync(path.join(dir, 'raw-provider'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'traces'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'raw-provider', 'raw-provider-events.ndjson'),
      `${JSON.stringify({ eventId: 'req-1', direction: 'request' })}\n`,
    )
    fs.writeFileSync(
      path.join(dir, 'traces', 'trace.ndjson'),
      `${JSON.stringify({ runId: 'run-1', kind: 'llm' })}\n`,
    )

    const check = inspectAgentEvalCaptureArtifacts(dir, { require: true })

    expect(check.passed).toBe(true)
    expect(check.rawProviderEvents).toBe(1)
    expect(check.traceRows).toBe(1)
    expect(check.failures).toEqual([])
  })
})
