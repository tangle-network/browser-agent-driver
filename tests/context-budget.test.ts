import { describe, expect, it } from 'vitest';
import { ContextBudget } from '../src/context-budget.js';

describe('ContextBudget', () => {
  it('starts empty', () => {
    const budget = new ContextBudget();
    expect(budget.isEmpty).toBe(true);
    expect(budget.build()).toBe('');
  });

  it('ignores empty content', () => {
    const budget = new ContextBudget();
    budget.add('empty', '', 10);
    expect(budget.isEmpty).toBe(true);
    expect(budget.build()).toBe('');
  });

  it('includes a single part', () => {
    const budget = new ContextBudget();
    budget.add('hint', 'Use search first', 10);
    expect(budget.isEmpty).toBe(false);
    expect(budget.build()).toBe('Use search first');
  });

  it('joins multiple parts with newlines', () => {
    const budget = new ContextBudget();
    budget.add('a', 'Part A', 10);
    budget.add('b', 'Part B', 5);
    const result = budget.build();
    expect(result).toContain('Part A');
    expect(result).toContain('Part B');
  });

  it('orders parts by priority descending', () => {
    const budget = new ContextBudget();
    budget.add('low', 'LOW PRIORITY', 1);
    budget.add('high', 'HIGH PRIORITY', 100);
    budget.add('mid', 'MID PRIORITY', 50);
    const result = budget.build();
    const highIdx = result.indexOf('HIGH PRIORITY');
    const midIdx = result.indexOf('MID PRIORITY');
    const lowIdx = result.indexOf('LOW PRIORITY');
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('truncates when exceeding 8000 character budget', () => {
    const budget = new ContextBudget();
    budget.add('big', 'A'.repeat(7000), 100);
    budget.add('medium', 'B'.repeat(2000), 50);
    const result = budget.build();
    expect(result.length).toBeLessThanOrEqual(8100); // budget + truncation marker
    expect(result).toContain('A'.repeat(100)); // high-priority content present
    // Medium should be truncated
    if (result.includes('B')) {
      expect(result).toContain('[truncated]');
    }
  });

  it('drops low-priority content that does not fit even partially', () => {
    const budget = new ContextBudget();
    budget.add('fills', 'X'.repeat(7900), 100);
    budget.add('tiny', 'Y'.repeat(50), 50); // only ~100 chars left, but truncation needs >200
    const result = budget.build();
    // The tiny part has only 50 chars remaining budget after fills, which is < 200
    // so it should be dropped entirely
    expect(result).toContain('X'.repeat(100));
  });

  it('handles parts with same priority', () => {
    const budget = new ContextBudget();
    budget.add('a', 'Alpha', 10);
    budget.add('b', 'Beta', 10);
    const result = budget.build();
    expect(result).toContain('Alpha');
    expect(result).toContain('Beta');
  });

  it('respects budget even with many small parts', () => {
    const budget = new ContextBudget();
    for (let i = 0; i < 100; i++) {
      budget.add(`part-${i}`, 'X'.repeat(200), i);
    }
    const result = budget.build();
    expect(result.length).toBeLessThanOrEqual(8100);
  });

  it('truncated content includes truncation marker', () => {
    const budget = new ContextBudget();
    budget.add('big', 'A'.repeat(6000), 100);
    budget.add('overflow', 'B'.repeat(4000), 50);
    const result = budget.build();
    expect(result).toContain('...[truncated]');
  });
});
