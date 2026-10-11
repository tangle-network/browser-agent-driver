---
"@tangle-network/browser-agent-driver": patch
---

Fix `complete` actions with a structured (object/array/number) `result` being silently blanked to an empty string. Models that follow JSON-output task instructions literally emit `"result": {"year": 1815}`; the action parser string-typed the field and coerced non-strings to `""`, losing the agent's answer. Non-string results are now JSON-serialized.
