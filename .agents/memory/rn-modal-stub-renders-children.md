---
name: RN Modal test stub renders children even when closed
description: Why two same-component modals collide on shared testIDs in labtrax mobile vitest, and the namespacing fix.
---

The labtrax mobile test stub (`artifacts/labtrax/test-stubs/react-native.ts`)
implements `Modal` as `makeHost("Modal")` — a plain host that renders its
children **regardless of the `visible` prop**. Real RN hides a closed Modal;
the stub does not.

**Consequence:** when two instances of the same modal-bearing component are
mounted at once (e.g. two `DateField` calendar pickers in the invoice custom
date range), every fixed internal `testID` (`cal-prev`, `cal-next`,
`cal-day-N`, `cal-clear`) appears twice → `getByTestId` throws "multiple
elements" and day cells are ambiguous even before you "open" a picker.

**Fix / how to apply:** namespace a reusable component's internal testIDs by
the caller-supplied trigger `testID`
(`const idFor = (s) => testID ? \`\${testID}-\${s}\` : \`cal-\${s}\``), keeping a
legacy fallback for single-instance callers. Then tests address
`custom-date-start-day-15` vs `custom-date-end-day-15` unambiguously.

**Why:** the stub's always-render behavior is intentional (lets smoke tests
reach modal content without simulating open), so the burden is on components
that can appear more than once per screen to keep their testIDs unique.
