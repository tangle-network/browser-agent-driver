import { cliError } from '../../cli-ui.js';

export interface PreviewCommandOptions {
  goal: string | undefined;
  url: string | undefined;
  model: string | undefined;
  provider: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  sink: string | undefined;
  json: boolean;
  maxSteps: string | undefined;
  headed: boolean | undefined;
}

export async function runPreviewCommand(opts: PreviewCommandOptions): Promise<void> {
  if (!opts.goal || !opts.url) {
    cliError('usage: bad preview --goal "..." --url <url> [--max-steps 12] [--headed] [--json] [--out plan.json]');
    process.exit(1);
  }
  const { handlePreviewCommand, PreviewError } = await import('../../cli-preview.js');
  try {
    const result = await handlePreviewCommand({
      goal: opts.goal,
      url: opts.url,
      model: opts.model,
      provider: opts.provider,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      output: opts.sink,
      json: opts.json,
      maxSteps: opts.maxSteps ? parseInt(opts.maxSteps, 10) : undefined,
      headed: opts.headed,
    });
    process.exit(result.plan ? 0 : 1);
  } catch (err) {
    if (err instanceof PreviewError) {
      cliError(err.message);
      process.exit(1);
    }
    throw err;
  }
}
