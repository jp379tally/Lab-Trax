---
name: RN Modal keyboard avoidance
description: React Native <Modal> content is not covered by a screen-level KeyboardAvoidingView; bottom-sheet modals with TextInputs need their own KAV inside.
---

# RN <Modal> needs its OWN KeyboardAvoidingView

A React Native `<Modal>` renders in a **separate native view hierarchy** (its own
window/root view). A `KeyboardAvoidingView` that wraps the *screen* does **not**
apply to modal content, even though the `<Modal>` is written as a JSX child of
that KAV.

**Symptom:** a bottom-sheet modal (`modalOverlay` with `justifyContent:"flex-end"`)
that contains `TextInput`s + a submit button — when the keyboard opens (often via
`autoFocus`), it covers the lower fields and the submit button, so the user can
type but can't reach/submit. Looks like "the keyboard is in the way."

**Fix:** wrap the modal's content in its own `KeyboardAvoidingView` *inside* the
`<Modal>`:
- iOS: `behavior="padding"` (pushes the flex-end sheet above the keyboard).
- Android: `behavior={undefined}` when no `android.softwareKeyboardLayoutMode` is
  set — Expo defaults to `"resize"` (adjustResize), so the window already shrinks
  and a flex-end sheet clears the keyboard natively. Adding `behavior="height"`
  there risks double-handling and the sheet jumping.

**Why:** this app's AI Reader "Review Extraction" screen
(`artifacts/labtrax/app/ai-reader/extracted.tsx`) wraps the whole screen in a KAV
but the inline create-practice form lives in a picker `<Modal>`; the screen KAV
was a no-op for it.

**How to apply:** any time a `<Modal>` in this codebase holds editable
`TextInput`s, give it its own KAV. Note this file has several modals
(add-doctor, confidence tooltip, duplicate, practice-picker) — the picker is the
one fixed; the add-doctor modal also has a TextInput and could need the same
treatment if a covered-input report comes in.
