import { ProjectStore } from '../../memory/project-store.js';
import { RunRegistry } from '../../memory/run-registry.js';

export interface RunsCommandOptions {
  memoryDir: string | undefined;
  url: string | undefined;
  sessionId: string | undefined;
  json: boolean;
}

export async function runRunsCommand({ memoryDir, url, sessionId, json }: RunsCommandOptions): Promise<void> {
  const store = new ProjectStore(memoryDir)
  const registry = new RunRegistry(store.getRoot())
  const runs = registry.listRuns({
    domain: url ? new URL(url).hostname : undefined,
    sessionId,
    limit: 20,
  })
  if (runs.length === 0) {
    console.log('  No runs found.')
  } else if (json) {
    console.log(JSON.stringify(runs, null, 2))
  } else {
    for (const r of runs) {
      const icon = r.status === 'completed' ? (r.success ? '✓' : '✗') : '○'
      const ts = r.startedAt.slice(0, 16).replace('T', ' ')
      const dur = r.completedAt
        ? `${Math.round((new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)}s`
        : 'running'
      const session = r.sessionId ? ` [${r.sessionId}]` : ''
      const parent = r.parentRunId ? ` ← ${r.parentRunId.slice(0, 20)}` : ''
      console.log(`  ${icon} ${r.runId.slice(0, 30)}  ${ts}  ${dur}  ${r.goal.slice(0, 50)}${session}${parent}`)
      if (r.summary) console.log(`    ${r.summary.slice(0, 80)}`)
      if (r.finalUrl) console.log(`    ${r.finalUrl}`)
    }
  }
  process.exit(0)
}
