import { createHash } from 'node:crypto'

/** 12-hex-char SHA-256 prefix — collision-resistant enough for prompt/rubric
 *  identity without being noisy. Mirrors agent-eval's PromptRegistry style. */
export function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12)
}
