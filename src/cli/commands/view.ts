import { cliError } from '../../cli-ui.js';

export interface ViewCommandOptions {
  runDir: string | undefined;
  port: string | undefined;
  noOpen: boolean | undefined;
}

export async function runViewCommand({ runDir, port, noOpen }: ViewCommandOptions): Promise<void> {
  if (!runDir) {
    cliError('usage: bad view <run-directory>');
    process.exit(1);
  }
  const { runViewCli, ViewError } = await import('../../cli-view.js');
  try {
    await runViewCli({
      runDir,
      port: port ? parseInt(port) : undefined,
      noOpen,
    });
  } catch (err) {
    if (err instanceof ViewError) {
      cliError(err.message);
      process.exit(1);
    }
    throw err;
  }
}
