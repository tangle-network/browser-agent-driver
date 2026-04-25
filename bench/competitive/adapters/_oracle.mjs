/**
 * Shared oracle evaluator for competitive bench tasks.
 *
 * Oracles are evaluated against a "final state" object that every adapter
 * is expected to produce. The final state has the shape:
 *
 *   {
 *     finalUrl: string,
 *     finalTitle: string,
 *     finalSnapshot: string,    // ARIA snapshot or visible-text dump
 *     resultText?: string,      // structured result the agent emitted on `complete`
 *   }
 *
 * Adapters are responsible for producing this object — `bad` reads it from
 * the last observe-completed event in events.jsonl, browser-use reads it
 * from its own trace, etc.
 *
 * Oracle types:
 *   - text-in-snapshot: case-insensitive substring match on finalSnapshot OR resultText
 *   - url-contains:     substring match on finalUrl
 *   - json-shape-match: every key in expectedShape present in resultText (parsed as JSON);
 *                       value match on literal equality, or regex when string starts with `re:`
 *   - selector-state:   degraded form, treats expectedText as text-in-snapshot
 *                       (full selector check would need a live Playwright session)
 */

export function evaluateOracle(oracle, finalState) {
  if (!oracle || typeof oracle !== 'object' || !oracle.type) {
    return { passed: false, reason: 'no oracle defined', detail: '' }
  }

  switch (oracle.type) {
    case 'text-in-snapshot':
      return evaluateTextInSnapshot(oracle, finalState)
    case 'url-contains':
      return evaluateUrlContains(oracle, finalState)
    case 'json-shape-match':
      return evaluateJsonShape(oracle, finalState)
    case 'selector-state':
      // Degraded: same as text-in-snapshot. Use the expectedText field.
      return evaluateTextInSnapshot(
        { type: 'text-in-snapshot', expectedText: oracle.expectedText },
        finalState,
      )
    default:
      return { passed: false, reason: `unknown oracle type ${oracle.type}`, detail: '' }
  }
}

function evaluateTextInSnapshot(oracle, finalState) {
  const expected = String(oracle.expectedText ?? '').trim()
  if (!expected) return { passed: false, reason: 'empty expectedText', detail: '' }
  const haystacks = [
    String(finalState?.finalSnapshot ?? ''),
    String(finalState?.resultText ?? ''),
  ]
  const needle = expected.toLowerCase()
  for (const h of haystacks) {
    if (h.toLowerCase().includes(needle)) {
      return { passed: true, reason: 'text-in-snapshot match', detail: `found "${expected}"` }
    }
  }
  return {
    passed: false,
    reason: 'text-in-snapshot miss',
    detail: `did not find "${expected}" in snapshot or resultText`,
  }
}

function evaluateUrlContains(oracle, finalState) {
  const expected = String(oracle.expectedUrlFragment ?? '').trim()
  if (!expected) return { passed: false, reason: 'empty expectedUrlFragment', detail: '' }
  const url = String(finalState?.finalUrl ?? '')
  if (url.includes(expected)) {
    return { passed: true, reason: 'url-contains match', detail: `${url} contains "${expected}"` }
  }
  return { passed: false, reason: 'url-contains miss', detail: `${url} does not contain "${expected}"` }
}

function evaluateJsonShape(oracle, finalState) {
  const expected = oracle.expectedShape
  if (!expected || typeof expected !== 'object') {
    return { passed: false, reason: 'invalid expectedShape', detail: '' }
  }
  const resultText = String(finalState?.resultText ?? '').trim()
  let parsed
  try {
    parsed = JSON.parse(resultText)
  } catch {
    // Try to extract a JSON object from a markdown code block
    const fence = resultText.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) {
      try {
        parsed = JSON.parse(fence[1])
      } catch {
        return { passed: false, reason: 'resultText is not valid JSON', detail: '' }
      }
    } else {
      return { passed: false, reason: 'resultText is not valid JSON', detail: '' }
    }
  }
  // JSON.parse('null') returns null, which is valid JSON but not an object;
  // same for arrays at the top level when the schema expects an object.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      passed: false,
      reason: 'resultText is not a JSON object',
      detail: `parsed type: ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
    }
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!(key in parsed)) {
      return { passed: false, reason: `missing key ${key}`, detail: '' }
    }
    if (expectedValue === null) continue
    // Array shape: ["re:.{5,}", "re:.{5,}", "re:.{5,}"] means parsed[key] must
    // be an array of exactly that length where each element matches the
    // corresponding regex. Used for tasks that expect a fixed-size array of
    // strings (e.g. "extract the top 3 reddit titles").
    if (Array.isArray(expectedValue)) {
      if (!Array.isArray(parsed[key])) {
        return { passed: false, reason: `${key} is not an array`, detail: `got ${typeof parsed[key]}` }
      }
      if (parsed[key].length !== expectedValue.length) {
        return { passed: false, reason: `${key} array length mismatch`, detail: `expected ${expectedValue.length}, got ${parsed[key].length}` }
      }
      for (let i = 0; i < expectedValue.length; i++) {
        const elemSpec = expectedValue[i]
        const elemValue = parsed[key][i]
        if (elemSpec === null) continue
        if (typeof elemSpec === 'string' && elemSpec.startsWith('re:')) {
          const re = new RegExp(elemSpec.slice(3))
          if (!re.test(String(elemValue))) {
            return { passed: false, reason: `${key}[${i}] regex mismatch`, detail: `${elemValue} !~ ${re}` }
          }
        } else if (elemValue !== elemSpec) {
          return { passed: false, reason: `${key}[${i}] value mismatch`, detail: `${elemValue} !== ${elemSpec}` }
        }
      }
      continue
    }
    if (typeof expectedValue === 'string' && expectedValue.startsWith('re:')) {
      const re = new RegExp(expectedValue.slice(3))
      if (!re.test(String(parsed[key]))) {
        return { passed: false, reason: `regex mismatch on ${key}`, detail: `${parsed[key]} !~ ${re}` }
      }
    } else if (parsed[key] !== expectedValue) {
      return { passed: false, reason: `value mismatch on ${key}`, detail: `${parsed[key]} !== ${expectedValue}` }
    }
  }
  return { passed: true, reason: 'json-shape-match all keys present', detail: '' }
}
