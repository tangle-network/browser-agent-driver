import { describe, expect, it } from 'vitest';
import { classifyFailure, classifyFailureReason, isExternalBlockerFailureClass } from '../scripts/lib/failure-taxonomy.mjs';

describe('failure taxonomy', () => {
  it('classifies API key issues as external blockers', () => {
    const cls = classifyFailureReason("Incorrect API key provided: ''");
    expect(cls).toBe('llm_or_credentials');
    expect(isExternalBlockerFailureClass(cls)).toBe(true);
  });

  it('classifies max-turn stalls as non-blocker agent failures', () => {
    const cls = classifyFailureReason('Max turns (35) reached');
    expect(cls).toBe('planner_stall_max_turns');
    expect(isExternalBlockerFailureClass(cls)).toBe(false);
  });

  it('classifies pre-first-turn timeouts separately from in-loop timeouts', () => {
    const cls = classifyFailureReason('Pre-first-turn timeout after 5000ms');
    expect(cls).toBe('startup_timeout');
    expect(isExternalBlockerFailureClass(cls)).toBe(false);
  });

  it('prefers runtime log evidence over coarse reason text', () => {
    const result = classifyFailure({
      reason: 'Failed',
      runtimeLog: {
        responseErrors: [
          { status: '403', statusText: 'Forbidden', url: 'https://app.example.com/api/me' },
        ],
      },
    });
    expect(result.failureClass).toBe('auth_or_permissions');
    expect(result.source).toBe('runtime-log');
    expect(result.evidence[0]).toContain('403');
  });

  it('classifies server-side runtime failures from runtime logs', () => {
    const result = classifyFailure({
      reason: 'Unknown failure',
      runtimeLog: {
        pageErrors: [{ message: 'Uncaught TypeError: Cannot read properties of undefined' }],
        responseErrors: [{ status: '500', statusText: 'Internal Server Error' }],
      },
    });
    expect(result.failureClass).toBe('app_or_server_error');
    expect(result.source).toBe('runtime-log');
  });

  it('classifies benchmark domain-constraint failures as external blockers', () => {
    const cls = classifyFailureReason(
      "Cannot complete within the constraint 'Only use www.alberta.ca'. Accessing https://open.alberta.ca would violate requirement.",
    );
    expect(cls).toBe('benchmark_constraint');
    expect(isExternalBlockerFailureClass(cls)).toBe(true);
  });
});
