# Reporters & Sinks

## Report Formats

```typescript
import { generateReport } from '@tangle-network/agent-browser-driver'

generateReport(suiteResult, { format: 'json' })      // full TestSuiteResult
generateReport(suiteResult, { format: 'markdown' })   // summary + per-test table
generateReport(suiteResult, { format: 'html' })       // styled dashboard
generateReport(suiteResult, { format: 'junit' })      // JUnit XML
```

JUnit XML is parsed natively by GitHub Actions, Jenkins, and GitLab. Tests grouped by `testCase.category`.

## Artifact Sinks

### FilesystemSink

```typescript
import { FilesystemSink } from '@tangle-network/agent-browser-driver'

const sink = new FilesystemSink('./results')
// writes: results/{testId}/turn-05.jpg, results/manifest.json
```

### WebhookSink

POST artifact events to Slack, Discord, or any URL:

```typescript
import { WebhookSink } from '@tangle-network/agent-browser-driver'

const sink = new WebhookSink({
  url: 'https://hooks.slack.com/services/...',
  headers: { Authorization: 'Bearer token' },
  events: ['screenshot', 'report-json'],
  includeData: false,
  retries: 3,
})
```

Events:
- `put()` → `{ "event": "artifact", "testId": "signup", "type": "screenshot", "name": "turn-05.jpg" }`
- `close()` → `{ "event": "suite:complete", "manifest": [...], "summary": { "total": 5, "passed": 4 } }`

Webhook failures are logged, never thrown.

### CompositeSink

Chain multiple sinks:

```typescript
import { CompositeSink, FilesystemSink, WebhookSink } from '@tangle-network/agent-browser-driver'

const sink = new CompositeSink([
  new FilesystemSink('./results'),
  new WebhookSink({ url: '...' }),
])
```
