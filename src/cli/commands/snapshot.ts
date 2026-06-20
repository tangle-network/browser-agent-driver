import { cliError } from '../../cli-ui.js';

export interface SnapshotCommandOptions {
  url: string | undefined;
  json: boolean;
  out: string | undefined;
  timeout: string | undefined;
  wait: string | undefined;
  dismissModals: boolean | undefined;
  headed: boolean | undefined;
  debug: boolean;
}

export async function runSnapshotCommand(opts: SnapshotCommandOptions): Promise<void> {
  if (!opts.url) {
    cliError('usage: bad snapshot --url <url> [--json] [--out file.json] [--wait networkidle|load|domcontentloaded|commit] [--timeout <ms>] [--no-dismiss-modals] [--headed]');
    process.exit(2);
  }
  const waitArg = opts.wait;
  const wait = waitArg === 'load' || waitArg === 'domcontentloaded' || waitArg === 'networkidle' || waitArg === 'commit'
    ? waitArg
    : undefined;
  const { handleSnapshotCommand } = await import('../../cli-snapshot.js');
  const rc = await handleSnapshotCommand({
    url: opts.url,
    json: opts.json,
    out: opts.out,
    timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
    wait,
    dismissModals: opts.dismissModals,
    headed: opts.headed,
    debug: opts.debug,
  });
  process.exit(rc);
}
