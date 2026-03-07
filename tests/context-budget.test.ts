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

  it('truncates second part when total exceeds 8000 char budget', () => {
    const budget = new ContextBudget();
    budget.add('big', 'A'.repeat(7000), 100);
    budget.add('medium', 'B'.repeat(2000), 50);
    const result = budget.build();
    // High-priority 7000-char part fits fully
    expect(result).toContain('A'.repeat(7000));
    // Medium part gets truncated to remaining ~1000 chars + marker
    expect(result).toContain('B'.repeat(100)); // some B content present
    expect(result).toContain('...[truncated]');
    expect(result.length).toBeLessThanOrEqual(8100);
  });

  it('drops content after first truncation (break behavior)', () => {
    const budget = new ContextBudget();
    budget.add('fills', 'A'.repeat(7500), 100);
    budget.add('truncated', 'B'.repeat(1000), 50);
    budget.add('dropped', 'C'.repeat(500), 25);
    const result = budget.build();
    // A fits fully, B is truncated, C is dropped entirely due to break
    expect(result).toContain('A'.repeat(7500));
    expect(result).toContain('...[truncated]');
    expect(result).not.toContain('C');
  });

  it('drops low-priority content when remaining budget is <= 200', () => {
    const budget = new ContextBudget();
    budget.add('fills', 'X'.repeat(7900), 100);
    // 200 chars exceeds remaining (8000-7900=100), and remaining <= 200, so dropped entirely
    budget.add('overflow', 'Y'.repeat(200), 50);
    const result = budget.build();
    expect(result).toContain('X'.repeat(7900));
    expect(result).not.toContain('Y');
    expect(result).not.toContain('[truncated]');
  });

  it('includes low-priority content that fits within remaining budget', () => {
    const budget = new ContextBudget();
    budget.add('fills', 'X'.repeat(7900), 100);
    budget.add('tiny', 'Y'.repeat(50), 50); // 7900 + 50 = 7950 < 8000, fits
    const result = budget.build();
    expect(result).toContain('X'.repeat(7900));
    expect(result).toContain('Y'.repeat(50));
  });

  it('includes part that exactly fills the budget', () => {
    const budget = new ContextBudget();
    budget.add('exact', 'Z'.repeat(8000), 100);
    const result = budget.build();
    expect(result).toBe('Z'.repeat(8000));
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
