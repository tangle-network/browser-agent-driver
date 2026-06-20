import { cliError } from '../../cli-ui.js';
import type { CliValues, CliPositionals } from '../args.js';

export async function runAuthCommand(values: CliValues, positionals: CliPositionals): Promise<void> {
  const sub = positionals[1];
  if (sub === 'save') {
    const { handleAuthSave } = await import('../../cli-auth.js');
    await handleAuthSave({
      url: values.url || positionals[2],
      output: values['storage-state'] || positionals[3],
    });
    process.exit(0);
  }
  if (sub === 'login') {
    const { handleAuthLogin } = await import('../../cli-auth.js');
    await handleAuthLogin({
      url: values.url || positionals[2],
      output: values['storage-state'],
      fill: values.fill,
      cookie: values.cookie,
      waitFor: values['wait-for'],
      waitTimeout: values['wait-timeout'] ? parseInt(values['wait-timeout'], 10) : undefined,
      headless: values.headless,
    });
    process.exit(0);
  }
  if (sub === 'check') {
    const { handleAuthCheck } = await import('../../cli-auth.js');
    await handleAuthCheck({
      path: values['storage-state'] || positionals[2],
      origin: positionals[3],
    });
    process.exit(0);
  }
  cliError(`Unknown auth subcommand: ${sub || '(none)'}. Use "auth save", "auth login", or "auth check".`);
  process.exit(1);
}
