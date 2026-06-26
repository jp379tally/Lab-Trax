---
name: getByRole name vs custom picker triggers
description: Why getByRole("button",{name}) fails to match custom dropdown triggers in labtrax-desktop vitest
---

In the labtrax-desktop vitest stack (jsdom + dom-accessibility-api 10.x),
`getByRole("button", { name: /…/ })` does NOT reliably match a custom picker
trigger whose accessible name comes only from a nested `<span>` plus an
`aria-hidden` icon (e.g. PracticePicker / DoctorNamePicker triggers). The
element renders and the text is visible in the DOM dump, yet the name lookup
returns zero matches and the query throws "Unable to find role=button and
name …".

**Why:** the trigger is a plain `<button>` wrapping `<span>{label}</span>` and
an aria-hidden svg; the accessible-name-from-content computation in this version
doesn't surface that nested text as the button's name for the regex matcher. It
cost several attempts to diagnose because the DOM clearly contains the text.

**How to apply:** don't query these custom triggers by role+name. Add a stable
`data-testid` to the trigger (and any in-dropdown action such as "add new") and
use `getByTestId`/`queryByTestId`. Query option rows by their unique visible
label text (`getByText`) and the search box by its placeholder. If you ever
need the role+name path to work, give the trigger an explicit `aria-label`.
