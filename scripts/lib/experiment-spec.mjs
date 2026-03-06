import fs from 'node:fs';
import path from 'node:path';

export function loadExperimentSpec(specPath) {
  const absolutePath = path.resolve(specPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Experiment spec not found: ${absolutePath}`);
  }

  const raw = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
  if (!raw || typeof raw !== 'object') {
    throw new Error('Experiment spec must be a JSON object.');
  }

  if (!Array.isArray(raw.arms) || raw.arms.length < 1) {
    throw new Error('Experiment spec requires a non-empty "arms" array.');
  }

  const arms = raw.arms.map((arm, index) => {
    if (!arm || typeof arm !== 'object') {
      throw new Error(`Experiment arm at index ${index} must be an object.`);
    }
    if (!arm.id || typeof arm.id !== 'string') {
      throw new Error(`Experiment arm at index ${index} is missing string "id".`);
    }
    if (!arm.configPath || typeof arm.configPath !== 'string') {
      throw new Error(`Experiment arm "${arm.id}" is missing string "configPath".`);
    }
    return {
      id: arm.id,
      configPath: path.resolve(arm.configPath),
      promptFile: typeof arm.promptFile === 'string' ? path.resolve(arm.promptFile) : undefined,
      modelAdaptive: arm.modelAdaptive === true,
      navModel: typeof arm.navModel === 'string' ? arm.navModel : undefined,
      navProvider: typeof arm.navProvider === 'string' ? arm.navProvider : undefined,
    };
  });

  return {
    specPath: absolutePath,
    spec: raw,
    resolved: {
      casesPath: typeof raw.casesPath === 'string' ? path.resolve(raw.casesPath) : undefined,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      storageState: typeof raw.storageState === 'string' ? path.resolve(raw.storageState) : undefined,
      repetitions: parseOptionalInt(raw.repetitions),
      concurrency: parseOptionalInt(raw.concurrency),
      scenarioConcurrency: parseOptionalInt(raw.scenarioConcurrency),
      benchmarkProfile: typeof raw.benchmarkProfile === 'string' ? raw.benchmarkProfile : undefined,
      fixtureBaseUrl: typeof raw.fixtureBaseUrl === 'string' ? raw.fixtureBaseUrl : undefined,
      memoryIsolation: typeof raw.memoryIsolation === 'string' ? raw.memoryIsolation : undefined,
      memoryRoot: typeof raw.memoryRoot === 'string' ? path.resolve(raw.memoryRoot) : undefined,
      arms,
    },
  };
}

function parseOptionalInt(value) {
  if (value === undefined || value === null) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
