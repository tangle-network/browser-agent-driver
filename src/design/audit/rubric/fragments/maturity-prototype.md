---
id: maturity-prototype
title: Prototype / Template Detection
weight: high
applies-when:
  maturity: [prototype, mvp]
  designSystem: [shadcn, mui, ant, chakra]
---

TEMPLATE-DETECTION CRITERIA — apply when this looks like an unmodified component-library app:

The #1 sin of vibecoded / AI-generated apps is shipping unmodified component library defaults:
- Default border-radius (6-8px shadcn, 4px MUI)
- Default color palette (zinc/slate grays, blue-600 primary)
- Default component spacing with no customization
- Standard card shadows, stock empty states
- "Looks like every other AI-generated app" = automatic 3-4 score

HIERARCHY & INFORMATION ARCHITECTURE:
- Is everything the same visual weight? (Common AI pattern: all cards same size)
- Clear primary/secondary/tertiary action distinction?
- Layout has purpose, or is it "centered column of cards"?

DESIGN SYSTEM COHERENCE:
- More than 3 distinct border-radius values = incoherent
- Color palette: intentional limited (4-6) vs random accumulation
- Spacing: 8px grid rhythm vs arbitrary per-component
- Typography: deliberate scale with 3-4 sizes vs every component picking its own

CRAFT SIGNALS (separates 7 from 9):
- Custom icons or generic Lucide/Heroicons dump?
- Micro-interactions: button feedback, page transitions, loading skeletons
- Empty states: designed illustrations or "No data found" text?
- Error states: helpful with recovery actions or raw error strings?

CEILING: Unmodified template apps cap at 4 regardless of functionality. State this in the score reasoning.
