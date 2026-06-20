import { cliError } from '../../cli-ui.js';
import type { CliValues } from '../args.js';

export async function runDesignAuditCommand(values: CliValues): Promise<void> {
  if (!values.url) {
    cliError('--url is required for design-audit.');
    process.exit(1);
  }

  // --design-compare mode
  if (values['design-compare']) {
    if (!values['compare-url']) {
      cliError('--compare-url is required with --design-compare.');
      process.exit(1);
    }
    const { runDesignCompare } = await import('../../design/compare.js');
    await runDesignCompare({
      urlA: values.url,
      urlB: values['compare-url'],
      headless: values.headless,
      outputDir: values.sink,
    });
    process.exit(0);
  }

  // --rip mode
  if (values.rip) {
    const { ripSite } = await import('../../design/rip.js');
    await ripSite({
      url: values.url,
      pages: values.pages ? parseInt(values.pages) : undefined,
      headless: values.headless,
      outputDir: values.sink,
    });
    process.exit(0);
  }

  const { runDesignAudit } = await import('../../cli-design-audit.js');
  await runDesignAudit({
    url: values.url,
    pages: values.pages ? parseInt(values.pages) : undefined,
    profile: values.profile,
    model: values.model,
    provider: values.provider,
    apiKey: values['api-key'],
    baseUrl: values['base-url'],
    output: values.sink,
    json: values.json,
    headless: values.headless,
    debug: values.debug,
    storageState: values['storage-state'],
    extractTokens: values['extract-tokens'],
    evolve: values.evolve,
    evolveRounds: values['evolve-rounds'] ? parseInt(values['evolve-rounds']) : undefined,
    projectDir: values['project-dir'],
    reproducibility: values.reproducibility,
    rubricsDir: values['rubrics-dir'],
    auditPasses: values['audit-passes'],
    skipEthics: values['skip-ethics'],
    ethicsRulesDir: values['ethics-rules-dir'],
    audience: values.audience,
    regulatoryContext: values['regulatory-context'],
    audienceVulnerability: values['audience-vulnerability'],
    modality: values.modality,
    reference: values.reference,
    referenceGrounded: values['reference-grounded'],
    judge: values.judge,
    judgeModels: values['judge-models'],
  });
  process.exit(0);
}
