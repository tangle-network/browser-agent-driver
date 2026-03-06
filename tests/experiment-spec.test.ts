import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadExperimentSpec } from '../scripts/lib/experiment-spec.mjs';

describe('experiment spec loader', () => {
  it('loads and resolves required fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-spec-'));
    const specPath = path.join(tmpDir, 'ab-spec.json');
    const armConfig = path.join(tmpDir, 'on.mjs');
    fs.writeFileSync(armConfig, 'export default {};');
    fs.writeFileSync(
      specPath,
      JSON.stringify({
        casesPath: './cases.json',
        model: 'gpt-5.2',
        repetitions: 2,
        arms: [
          {
            id: 'on',
            configPath: armConfig,
          },
        ],
      }),
    );

    const loaded = loadExperimentSpec(specPath);
    expect(loaded.specPath).toBe(path.resolve(specPath));
    expect(loaded.resolved.model).toBe('gpt-5.2');
    expect(loaded.resolved.repetitions).toBe(2);
    expect(loaded.resolved.arms[0]?.id).toBe('on');
    expect(loaded.resolved.arms[0]?.configPath).toBe(path.resolve(armConfig));
  });
});

