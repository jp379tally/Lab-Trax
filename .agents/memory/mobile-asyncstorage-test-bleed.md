---
name: Mobile AsyncStorage shared across tests in a file
description: Why a persist+restore-on-mount feature bleeds conversation/state across component tests, and the fix.
---

The mobile (`artifacts/labtrax`) vitest setup mocks `@react-native-async-storage/async-storage`
with a single in-memory `Map` created once at mock time. It is NOT cleared by
`resetMockAppState()` or `vi.clearAllMocks()`, so the store persists across every
test in a file.

**Consequence:** any screen that persists state to AsyncStorage and restores it on
mount (e.g. the AI assistant resuming the latest chat session) will have one test's
persisted state restored into the *next* test's mount. Symptom seen: `findByText`
fails with "Found multiple elements with text: …" because a prior test's
conversation bleeds into the current render.

**Why:** the restore-on-mount behavior is correct in production (resume last chat,
mirrors desktop). It is purely a test-isolation gap exposed by the shared mock Map.

**How to apply:** in the component test's `afterEach`, `await AsyncStorage.clear()`
(import the default from the mocked module). Do this for any screen test where the
screen reads/writes AsyncStorage on mount. The pure lib tests already do
`AsyncStorage.clear()` in `beforeEach`.
