#!/usr/bin/env node

/**
 * CLI for browser-agent-driver — run agent test cases from the command line.
 *
 * Usage:
 *   bad run --goal "Sign up" --url http://localhost:3000
 *   bad run --cases ./cases.json --concurrency 4
 *   bad run --cases ./cases.json --sink ./results/ --model claude-sonnet-4-20250514
 *
 * Designed for sandbox/container execution:
 *   docker run bad run --cases /data/cases.json --sink /output/
 */

import * as fs from 'node:fs';
import { loadLocalEnvFiles } from './env-loader.js';
import { cliError, printStyledHelp } from './cli-ui.js';
import { listPersonaIds } from './personas.js';
import { setCliVersion, setInvocation, getTelemetry } from './telemetry/index.js';
import { parseCliArgs } from './cli/args.js';
import { readCliVersion } from './cli/version.js';
import { RUN_MODES, DRIVER_PROFILES } from './cli/constants.js';

async function main(): Promise<void> {
  loadLocalEnvFiles(process.cwd());
  setCliVersion(readCliVersion());
  setInvocation(process.argv.slice(2)[0] || 'unknown', process.argv.slice(2));

  // Subcommand groups with their own arg shape — dispatch before the strict
  // parent parser (which only knows the run/design-audit/auth/showcase flags).
  const subArgs = process.argv.slice(2);
  if (subArgs[0] === 'jobs') {
    const { runJobsCli } = await import('./cli-jobs.js');
    await runJobsCli(subArgs.slice(1));
    process.exit(0);
  }
  if (subArgs[0] === 'reports') {
    const { runReportsCli } = await import('./cli-reports.js');
    await runReportsCli(subArgs.slice(1));
    process.exit(0);
  }

  const { values, positionals } = parseCliArgs();

  if (values.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    console.log(pkg.version);
    process.exit(0);
  }

  if (values.help || positionals.length === 0) {
    printStyledHelp(RUN_MODES, DRIVER_PROFILES, listPersonaIds());
    process.exit(0);
  }

  const command = positionals[0];

  if (command === 'view') {
    const { runViewCommand } = await import('./cli/commands/view.js');
    await runViewCommand({
      runDir: positionals[1],
      port: values.port,
      noOpen: values['no-open'],
    });
    return;
  }

  if (command === 'design-audit') {
    const { runDesignAuditCommand } = await import('./cli/commands/design-audit.js');
    await runDesignAuditCommand(values);
    return;
  }

  if (command === 'snapshot') {
    const { runSnapshotCommand } = await import('./cli/commands/snapshot.js');
    await runSnapshotCommand({
      url: values.url,
      json: values.json,
      out: values.out,
      timeout: values.timeout,
      wait: values.wait,
      dismissModals: values['dismiss-modals'],
      headed: values.headed,
      debug: values.debug,
    });
    return;
  }

  if (command === 'runs') {
    const { runRunsCommand } = await import('./cli/commands/runs.js');
    await runRunsCommand({
      memoryDir: values['memory-dir'],
      url: values.url,
      sessionId: values['session-id'],
      json: values.json,
    });
    return;
  }

  if (command === 'showcase') {
    const { runShowcaseCommand } = await import('./cli/commands/showcase.js');
    await runShowcaseCommand({
      url: values.url,
      script: values.script,
      capture: values.capture,
      crop: values.crop,
      highlight: values.highlight,
      format: values.format,
      viewport: values.viewport,
      sink: values.sink,
      headless: values.headless,
      colorScheme: values['color-scheme'],
      scale: values.scale,
      storageState: values['storage-state'],
      qualityThreshold: values['quality-threshold'],
    });
    return;
  }

  if (command === 'chrome-debug') {
    const { handleChromeDebugCommand } = await import('./cli/commands/chrome-debug.js');
    await handleChromeDebugCommand({
      attachPort: values['attach-port'],
      userDataDir: values['user-data-dir'],
      quiet: values.quiet,
    });
    return;
  }

  if (command === 'auth') {
    const { runAuthCommand } = await import('./cli/commands/auth.js');
    await runAuthCommand(values, positionals);
    return;
  }

  // `bad attach` is a top-level alias for `bad run --attach`. Every other
  // flag on `run` (--goal, --url, --model, --provider, --base-url,
  // --api-key, --show-cursor, --mode, --max-turns, --timeout, --no-memory,
  // --attach-port) works identically. Attach's mental model is "drive my
  // real Chrome," which is distinct enough from "spawn a fresh browser"
  // to deserve its own command name.
  if (command === 'attach') {
    values.attach = true;
  }

  // `bad preview` — plan-only dry-run. Observe the URL once, ask the
  // planner to emit a structured plan, render it, exit. No execution.
  // terraform plan for browser agents.
  if (command === 'preview') {
    const { runPreviewCommand } = await import('./cli/commands/preview.js');
    await runPreviewCommand({
      goal: values.goal,
      url: values.url,
      model: values.model,
      provider: values.provider,
      apiKey: values['api-key'],
      baseUrl: values['base-url'],
      sink: values.sink,
      json: values.json,
      maxSteps: values['max-steps'],
      headed: values.headed,
    });
    return;
  }

  // `bad share <run-id>` — create a bad-app share link, copy to clipboard.
  if (command === 'share') {
    const { runShareCommand } = await import('./cli/commands/share.js');
    await runShareCommand({
      runId: positionals[1],
      visibility: values.visibility,
      badAppUrl: values['bad-app-url'],
      apiKey: values['api-key'],
      noCopy: values['no-copy'],
      json: values.json,
    });
    return;
  }

  if (command !== 'run' && command !== 'attach') {
    cliError(`Unknown command: ${command}. Use "run", "attach", "preview", "runs", "view", "share", "chrome-debug", "design-audit", "showcase", "auth", "jobs", or "reports".`);
    process.exit(1);
  }

  const { runRunCommand } = await import('./cli/commands/run.js');
  await runRunCommand(values);
}

// Flush telemetry on every exit path (`process.exit` from inside main, throw, or
// natural completion). beforeExit fires before Node decides to terminate, so
// any pending HTTP POSTs from HttpTelemetrySink finish flushing before we go.
process.on('beforeExit', () => {
  void getTelemetry().close();
});

main().catch((err) => {
  cliError(err instanceof Error ? err.message : String(err));
  void getTelemetry().close().finally(() => process.exit(1));
});
