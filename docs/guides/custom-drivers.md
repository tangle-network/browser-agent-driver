# Custom Drivers

Implement the `Driver` interface to use a non-Playwright browser backend:

```typescript
import type { Driver, PageState, Action, ActionResult } from '@tangle-network/browser-agent-driver'
import type { Page } from 'playwright'

class MyDriver implements Driver {
  async observe(): Promise<PageState> { /* return a11y tree + metadata */ }
  async execute(action: Action): Promise<ActionResult> { /* run action, return result */ }
  getPage?(): Page | undefined { /* optional: expose underlying Page */ }
  async screenshot?(): Promise<Buffer> { /* optional: capture screenshot */ }
  async close?(): Promise<void> { /* optional: cleanup */ }
}
```

Pass your driver to `AgentRunner` or `TestRunner` the same way as `PlaywrightDriver`.
