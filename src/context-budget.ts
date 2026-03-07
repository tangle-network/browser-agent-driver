/**
 * ContextBudget — priority-based extra context builder with character budget.
 *
 * Replaces ad-hoc string concatenation in the runner loop.
 * Each context part is assigned a priority; when the total exceeds the budget,
 * lower-priority parts are truncated or dropped.
 */

const MAX_EXTRA_CONTEXT_CHARS = 8000;

export class ContextBudget {
  private parts: Array<{ label: string; content: string; priority: number }> = [];

  add(label: string, content: string, priority: number): void {
    if (!content) return;
    this.parts.push({ label, content, priority });
  }

  build(): string {
    // Sort by priority descending, then include as much as fits in budget
    const sorted = [...this.parts].sort((a, b) => b.priority - a.priority);
    let total = 0;
    const included: string[] = [];
    for (const part of sorted) {
      if (total + part.content.length > MAX_EXTRA_CONTEXT_CHARS) {
        const remaining = MAX_EXTRA_CONTEXT_CHARS - total;
        if (remaining > 200) {
          included.push(part.content.slice(0, remaining) + '...[truncated]');
          total += remaining;
        }
        break;
      }
      included.push(part.content);
      total += part.content.length;
    }
    return included.join('\n');
  }

  get isEmpty(): boolean {
    return this.parts.length === 0;
  }
}
