const BLOCKER_CLASSES = new Set([
  'terminal_network',
  'anti_bot_challenge',
  'auth_or_permissions',
  'quota_or_modal',
  'llm_or_credentials',
  'runtime_or_infra',
  'benchmark_constraint',
]);

export function classifyFailure(input) {
  const reason = typeof input === 'string' ? input : input?.reason;
  const runtimeLog = typeof input === 'string' ? undefined : input?.runtimeLog;
  const runtimeSignal = classifyFailureFromRuntime(runtimeLog);
  if (runtimeSignal) {
    return {
      failureClass: runtimeSignal.failureClass,
      source: 'runtime-log',
      evidence: runtimeSignal.evidence,
      fallbackReasonClass: classifyFailureReason(reason),
    };
  }

  return {
    failureClass: classifyFailureReason(reason),
    source: 'reason',
    evidence: [],
    fallbackReasonClass: null,
  };
}

export function classifyFailureReason(reasonRaw) {
  const reason = String(reasonRaw || '').toLowerCase();
  if (!reason) return 'unknown';

  if (
    /terminal blocker|chrome-error|err_name_not_resolved|this site can.?t be reached|destination is unreachable/.test(reason)
  ) return 'terminal_network';
  if (
    /cloudflare|verify you are human|captcha|turnstile|security verification|challenge/.test(reason)
  ) return 'anti_bot_challenge';
  if (
    /unauthorized|auth|login|session|cookie|forbidden|403/.test(reason)
  ) return 'auth_or_permissions';
  if (
    /quota|limit reached|project limit|modal|dialog/.test(reason)
  ) return 'quota_or_modal';
  if (
    /selector|stale ref|element not found|click intercepted|pointer/.test(reason)
  ) return 'selector_or_interaction';
  if (
    /max turns|out of remaining turns|turn budget|remaining turn budget/.test(reason)
  ) return 'planner_stall_max_turns';
  if (
    /pre-first-turn timeout|startup timeout/.test(reason)
  ) return 'startup_timeout';
  if (
    /timeout|timed out|observe timeout/.test(reason)
  ) return 'timeout';
  if (
    /incorrect api key|api key provided: ''|authorization failed|rate limit|llm/.test(reason)
  ) return 'llm_or_credentials';
  if (
    /browser has been closed|target page, context or browser has been closed|navigation failed/.test(reason)
  ) return 'runtime_or_infra';
  if (
    /would violate the requirement|cannot complete within the constraint|only use .* would violate|off-domain/.test(reason)
  ) return 'benchmark_constraint';
  return 'other';
}

export function classifyFailureFromRuntime(runtimeLog) {
  if (!runtimeLog || typeof runtimeLog !== 'object') return null;

  const consoleTexts = flattenRuntimeEntries(runtimeLog.console);
  const pageErrorTexts = flattenRuntimeEntries(runtimeLog.pageErrors);
  const requestFailureTexts = flattenRuntimeEntries(runtimeLog.requestFailures);
  const responseErrorTexts = flattenRuntimeEntries(runtimeLog.responseErrors);
  const traceError = String(runtimeLog.traceError || '');
  const texts = [
    ...consoleTexts,
    ...pageErrorTexts,
    ...requestFailureTexts,
    ...responseErrorTexts,
    traceError,
  ].filter(Boolean);

  const joined = texts.join('\n').toLowerCase();
  if (!joined) return null;

  if (/(cloudflare|captcha|turnstile|verify you are human|security verification|challenge)/.test(joined)) {
    return makeRuntimeSignal('anti_bot_challenge', texts, /(cloudflare|captcha|turnstile|verify you are human|security verification|challenge)/i);
  }
  if (/(err_name_not_resolved|dns|destination is unreachable|site can.?t be reached|net::err_|network error|connection refused)/.test(joined)) {
    return makeRuntimeSignal('terminal_network', texts, /(err_name_not_resolved|dns|destination is unreachable|site can.?t be reached|net::err_[a-z_]+|network error|connection refused)/i);
  }
  if (/(401|403|unauthorized|forbidden|not authorized|login required|session expired|authentication required)/.test(joined)) {
    return makeRuntimeSignal('auth_or_permissions', texts, /(401|403|unauthorized|forbidden|not authorized|login required|session expired|authentication required)/i);
  }
  if (/(quota|limit reached|project limit|billing|plan required|upgrade)/.test(joined)) {
    return makeRuntimeSignal('quota_or_modal', texts, /(quota|limit reached|project limit|billing|plan required|upgrade)/i);
  }
  if (/(incorrect api key|authorization failed|rate limit|openai|anthropic|model overloaded)/.test(joined)) {
    return makeRuntimeSignal('llm_or_credentials', texts, /(incorrect api key|authorization failed|rate limit|openai|anthropic|model overloaded)/i);
  }
  if (/(target page, context or browser has been closed|browser has been closed|trace.*failed|playwright)/.test(joined)) {
    return makeRuntimeSignal('runtime_or_infra', texts, /(target page, context or browser has been closed|browser has been closed|trace.*failed|playwright)/i);
  }

  const has5xx = Array.isArray(runtimeLog.responseErrors)
    && runtimeLog.responseErrors.some((entry) => Number.parseInt(String(entry?.status || ''), 10) >= 500);
  if (has5xx || pageErrorTexts.length > 0 || consoleTexts.some((text) => /\b(error|exception|uncaught)\b/i.test(text))) {
    return makeRuntimeSignal(
      'app_or_server_error',
      texts,
      /\b(error|exception|uncaught)\b|5\d\d/i,
    );
  }

  return null;
}

export function isExternalBlockerFailureClass(failureClass) {
  return BLOCKER_CLASSES.has(String(failureClass || 'unknown'));
}

function flattenRuntimeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      return Object.values(entry).map((value) => String(value || '')).join(' ').trim();
    })
    .filter(Boolean);
}

function makeRuntimeSignal(failureClass, texts, pattern) {
  return {
    failureClass,
    evidence: texts.filter((text) => pattern.test(text)).slice(0, 5),
  };
}
