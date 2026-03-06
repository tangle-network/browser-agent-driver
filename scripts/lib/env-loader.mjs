import fs from 'node:fs';
import path from 'node:path';

export function loadLocalEnvFiles(rootDir, files = ['.env.local', '.env']) {
  for (const file of files) {
    const filePath = path.join(rootDir, file);
    if (!fs.existsSync(filePath)) continue;
    const parsed = parseEnvFile(fs.readFileSync(filePath, 'utf-8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

export function assertApiKeyForModel(model) {
  const modelValue = String(model || '').toLowerCase();
  const needsOpenAI =
    modelValue.startsWith('gpt-') ||
    modelValue.startsWith('openai/') ||
    modelValue.includes('/gpt-') ||
    modelValue.startsWith('o1') ||
    modelValue.startsWith('o3') ||
    modelValue.startsWith('o4');

  if (needsOpenAI && !process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is required for the selected model. ' +
      'Set it in your shell or in .env/.env.local and retry.',
    );
  }
}

function parseEnvFile(contents) {
  const out = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
