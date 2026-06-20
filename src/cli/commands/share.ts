import { cliError } from '../../cli-ui.js';

export interface ShareCommandOptions {
  runId: string | undefined;
  visibility: string | undefined;
  badAppUrl: string | undefined;
  apiKey: string | undefined;
  noCopy: boolean | undefined;
  json: boolean;
}

export async function runShareCommand(opts: ShareCommandOptions): Promise<void> {
  const runId = opts.runId;
  if (!runId) {
    cliError('usage: bad share <run-id> [--visibility metadata|full|artifacts] [--json]');
    process.exit(1);
  }
  const { handleShareCommand, ShareError } = await import('../../cli-share.js');
  const visArg = opts.visibility;
  const visibility = visArg === 'full' || visArg === 'artifacts' || visArg === 'metadata'
    ? visArg
    : undefined;
  try {
    await handleShareCommand({
      runId,
      visibility,
      baseUrl: opts.badAppUrl,
      apiKey: opts.apiKey,
      noCopy: opts.noCopy,
      json: opts.json,
    });
    process.exit(0);
  } catch (err) {
    if (err instanceof ShareError) {
      cliError(err.message);
      process.exit(1);
    }
    throw err;
  }
}
