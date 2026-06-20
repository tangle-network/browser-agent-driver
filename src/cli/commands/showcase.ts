export interface ShowcaseCommandOptions {
  url: string | undefined;
  script: string | undefined;
  capture: string | undefined;
  crop: string | undefined;
  highlight: string | undefined;
  format: string | undefined;
  viewport: string | undefined;
  sink: string | undefined;
  headless: boolean | undefined;
  colorScheme: string | undefined;
  scale: string | undefined;
  storageState: string | undefined;
  qualityThreshold: string | undefined;
}

export async function runShowcaseCommand(opts: ShowcaseCommandOptions): Promise<void> {
  const { handleShowcase } = await import('../../cli-showcase.js');
  await handleShowcase({
    url: opts.url,
    script: opts.script,
    capture: opts.capture,
    crop: opts.crop,
    highlight: opts.highlight,
    format: opts.format,
    viewport: opts.viewport,
    output: opts.sink,
    headless: opts.headless ?? true,
    colorScheme: opts.colorScheme as 'dark' | 'light' | undefined,
    scale: opts.scale ? parseFloat(opts.scale) : undefined,
    storageState: opts.storageState,
    quality: opts.qualityThreshold ? parseInt(opts.qualityThreshold) : undefined,
  });
  process.exit(0);
}
