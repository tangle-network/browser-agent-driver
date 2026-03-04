# Agent-Friendly App Design

Use this skill when building product UIs that should be robust for autonomous browser agents while staying human-friendly.

## Principles
- Keep app behavior deterministic under load.
- Keep navigation discoverable without hidden dependencies.
- Prefer stable semantic controls over brittle visual-only hooks.

## High-ROI UI Conventions
- Use semantic buttons/inputs/labels with clear accessible names.
- Keep one primary action per step.
- Avoid duplicate action labels in the same viewport region.
- Use consistent route structure for key workflows.
- Expose predictable empty/loading/error states.

## Fast-Agent Hints (Optional, Not Required)
- Add stable `data-testid` attributes on critical workflow controls.
- Add concise inline helper text where blockers are common.
- Emit machine-readable run status labels in UI (`running`, `passed`, `failed`, `blocked`).

## Avoid
- Modal-heavy flows with no explicit dismiss/continue actions.
- Ambiguous “Run/Open/Continue” labels appearing multiple times.
- Full-page flicker for live-preview updates (update only the stream surface).

## Crypto/Wallet UX Specific
- Keep wallet-specific controls in isolated routes/components.
- Do not force wallet behavior globally for non-wallet flows.
- Provide explicit chain/account status indicators with deterministic labels.

## Validation Checklist
1. Can a new user find create/run/history/settings in <= 3 clicks?
2. Can an agent recover from quota/auth modal without human help?
3. Is there a stable selector path for every critical action?
4. Are run artifacts visible and downloadable from the UI?
