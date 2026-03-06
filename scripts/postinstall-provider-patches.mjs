#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function applyClaudeCodeExitPatch(source) {
  const alreadyPatched = source.includes('let receivedFinalResult = false;')
    && source.includes('Ignoring post-result process error');
  if (alreadyPatched) return source;

  const headerNeedle = '    let text = "";\n    let structuredOutput;\n';
  const resultNeedle = '        } else if (message.type === "result") {\n';
  const catchNeedle = `      } else {\n        throw this.handleClaudeCodeError(error, messagesPrompt, collectedStderr);\n      }\n`;

  if (!source.includes(headerNeedle) || !source.includes(resultNeedle) || !source.includes(catchNeedle)) {
    throw new Error('Claude Code provider patch failed: expected upstream anchors were not found.');
  }

  return source
    .replace(
      headerNeedle,
      '    let text = "";\n    let structuredOutput;\n    let receivedFinalResult = false;\n',
    )
    .replace(
      resultNeedle,
      '        } else if (message.type === "result") {\n          receivedFinalResult = true;\n',
    )
    .replace(
      catchNeedle,
      `      } else if (receivedFinalResult) {\n        warnings.push({\n          type: "other",\n          message: \`Claude Code process exited after emitting a final result: \${error instanceof Error ? error.message : String(error)}\`\n        });\n        this.logger.warn(\n          \`[claude-code] Ignoring post-result process error: \${error instanceof Error ? error.message : String(error)}\`\n        );\n      } else {\n        throw this.handleClaudeCodeError(error, messagesPrompt, collectedStderr);\n      }\n`,
    );
}

const patches = [
  {
    name: 'ai-sdk-provider-claude-code',
    file: path.join(ROOT, 'node_modules/ai-sdk-provider-claude-code/dist/index.js'),
    apply: applyClaudeCodeExitPatch,
  },
];

for (const patch of patches) {
  if (!fs.existsSync(patch.file)) continue;
  const original = fs.readFileSync(patch.file, 'utf8');
  const updated = patch.apply(original);
  if (updated !== original) {
    fs.writeFileSync(patch.file, updated, 'utf8');
    console.log(`[postinstall] patched ${patch.name}`);
  }
}
