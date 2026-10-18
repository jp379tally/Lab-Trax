import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MobileApp,
  scanContent,
  providesDismissal,
  isExcepted,
  TEXT_INPUT_COMPONENTS,
  DISMISSAL_COMPONENTS,
  DISMISSAL_SCAFFOLDS,
  DISMISS_HOOK,
  EXCEPTIONS,
  type ScanRoots,
  type Violation,
} from "../lint-mobile-keyboard-dismiss.js";

const SCREEN = "artifacts/labtrax/app/manage/new-screen.tsx";

const MOBILE_APP = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "artifacts",
  "labtrax"
);

/** A screen whose body is whatever the test passes in. */
function screenWith(body: string): string {
  return `import React from "react";
import { View, TextInput } from "react-native";

export default function NewScreen() {
  return (
${body}
  );
}
`;
}

describe("lint-mobile-keyboard-dismiss — an input with no way out fails", () => {
  it("flags a bare TextInput", () => {
    const violations = scanContent(
      screenWith(`    <View>
      <TextInput value={q} onChangeText={setQ} />
    </View>`),
      SCREEN
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe(SCREEN);
    expect(violations[0].component).toBe("TextInput");
    expect(violations[0].text).toContain("value={q}");
    expect(violations[0].reason).toContain("DismissKeyboardView");
    expect(violations[0].path).toContain("nothing containing it");
  });

  it("reports every uncovered input, not just the first", () => {
    const violations = scanContent(
      screenWith(`    <View>
      <TextInput value={a} onChangeText={setA} />
      <TextField label="B" value={b} onChangeText={setB} />
      <SuggestionInput value={c} onChangeText={setC} />
    </View>`),
      SCREEN
    );
    expect(violations.map((violation) => violation.component)).toEqual([
      "TextInput",
      "TextField",
      "SuggestionInput",
    ]);
  });

  it("reports 1-based line and column", () => {
    const content = `import React from "react";

export default function S() {
  return <TextInput value={q} onChangeText={setQ} />;
}
`;
    const [violation] = scanContent(content, SCREEN);
    expect(violation.line).toBe(4);
    expect(violation.column).toBe(10);
  });
});

describe("lint-mobile-keyboard-dismiss — containment, not co-occurrence", () => {
  it("a scaffold rendered beside the input does not protect it", () => {
    const violations = scanContent(
      screenWith(`    <View>
      <ListScreen title="Other list" />
      <TextInput value={q} onChangeText={setQ} />
    </View>`),
      SCREEN
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].component).toBe("TextInput");
  });

  it("a dismissal layer that wraps only a sibling does not protect the input", () => {
    const violations = scanContent(
      screenWith(`    <View>
      <DismissKeyboardView>
        <Header />
      </DismissKeyboardView>
      <TextInput value={q} onChangeText={setQ} />
    </View>`),
      SCREEN
    );
    expect(violations).toHaveLength(1);
  });

  it("importing a scaffold without rendering it protects nothing", () => {
    const content = `import { ListScreen } from "@/components/ui/ListScreen";
import { FormSheet } from "@/components/ui/FormSheet";

export default function S() {
  return <TextInput value={q} onChangeText={setQ} />;
}
`;
    expect(scanContent(content, SCREEN)).toHaveLength(1);
  });

  it("an input nested deep inside the layer is covered", () => {
    const violations = scanContent(
      screenWith(`    <DismissKeyboardView style={styles.screen}>
      <View>
        <View>
          <TextInput value={q} onChangeText={setQ} />
        </View>
      </View>
    </DismissKeyboardView>`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });

  it.each(DISMISSAL_COMPONENTS)("<%s> covers what it renders", (component) => {
    const violations = scanContent(
      screenWith(`    <${component}>
      <TextInput value={q} onChangeText={setQ} />
    </${component}>`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });

  it("an input handed to a scaffold as a prop is covered", () => {
    const violations = scanContent(
      screenWith(`    <ListScreen
      pinnedHeader={
        <View style={styles.searchWrap}>
          <TextInput value={q} onChangeText={setQ} />
        </View>
      }
    />`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });
});

describe("lint-mobile-keyboard-dismiss — the hook only counts when it is wired up", () => {
  it("covers an input under an element whose onPress is the hook's handler", () => {
    const content = `import { ${DISMISS_HOOK} } from "@/components/ui/DismissKeyboardView";

export default function S() {
  const dismissKeyboard = ${DISMISS_HOOK}();
  return (
    <Pressable onPress={dismissKeyboard} style={styles.sheet}>
      <TextInput value={q} onChangeText={setQ} />
    </Pressable>
  );
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("covers an input when the handler is called inside the press callback", () => {
    const content = `import { ${DISMISS_HOOK} } from "@/components/ui/DismissKeyboardView";

export default function S() {
  const dismissKeyboard = ${DISMISS_HOOK}();
  return (
    <Pressable onPress={() => { dismissKeyboard(); closeBackdrop(); }}>
      <TextInput value={q} onChangeText={setQ} />
    </Pressable>
  );
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("flags a screen that calls the hook but never wires it to a press target", () => {
    const content = `import { ${DISMISS_HOOK} } from "@/components/ui/DismissKeyboardView";

export default function S() {
  const dismissKeyboard = ${DISMISS_HOOK}();
  return (
    <View style={styles.sheet}>
      <TextInput value={q} onChangeText={setQ} />
    </View>
  );
}
`;
    expect(scanContent(content, SCREEN)).toHaveLength(1);
  });

  it("flags a handler wired to a sibling instead of an ancestor", () => {
    const content = `import { ${DISMISS_HOOK} } from "@/components/ui/DismissKeyboardView";

export default function S() {
  const dismissKeyboard = ${DISMISS_HOOK}();
  return (
    <View>
      <Pressable onPress={dismissKeyboard} />
      <TextInput value={q} onChangeText={setQ} />
    </View>
  );
}
`;
    expect(scanContent(content, SCREEN)).toHaveLength(1);
  });

  it("does not accept an unrelated press handler", () => {
    const content = `export default function S() {
  return (
    <Pressable onPress={() => router.back()}>
      <TextInput value={q} onChangeText={setQ} />
    </Pressable>
  );
}
`;
    expect(scanContent(content, SCREEN)).toHaveLength(1);
  });
});

describe("lint-mobile-keyboard-dismiss — drag dismissal on the scrollable counts", () => {
  it("covers an input inside a scrollable using the shared constant", () => {
    const violations = scanContent(
      screenWith(`    <ScrollView keyboardDismissMode={scrollKeyboardDismissMode}>
      <TextInput value={q} onChangeText={setQ} />
    </ScrollView>`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });

  it("covers an input inside a list that dismisses on drag", () => {
    const violations = scanContent(
      screenWith(`    <FlatList
      keyboardDismissMode="on-drag"
      ListHeaderComponent={<TextInput value={q} onChangeText={setQ} />}
    />`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });

  it("does not accept a scrollable that keeps the keyboard open", () => {
    const violations = scanContent(
      screenWith(`    <ScrollView keyboardDismissMode="none">
      <TextInput value={q} onChangeText={setQ} />
    </ScrollView>`),
      SCREEN
    );
    expect(violations).toHaveLength(1);
  });

  it("does not accept a scrollable rendered beside the input", () => {
    const violations = scanContent(
      screenWith(`    <View>
      <ScrollView keyboardDismissMode={scrollKeyboardDismissMode} />
      <TextInput value={q} onChangeText={setQ} />
    </View>`),
      SCREEN
    );
    expect(violations).toHaveLength(1);
  });
});

describe("lint-mobile-keyboard-dismiss — containment follows the file's own helpers", () => {
  it("covers a helper component rendered inside the layer", () => {
    const content = `export default function S() {
  return (
    <DismissKeyboardView>
      <SearchRow value={q} onChangeText={setQ} />
    </DismissKeyboardView>
  );
}

function SearchRow({ value, onChangeText }) {
  return (
    <View style={styles.searchWrap}>
      <TextInput value={value} onChangeText={onChangeText} />
    </View>
  );
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("covers a render function called inside the layer", () => {
    const content = `export default function S() {
  return <ScreenShell title="Lab profile">{renderField("Name", name, setName)}</ScreenShell>;
}

function renderField(label, value, setValue) {
  return (
    <View>
      <Text>{label}</Text>
      <TextInput value={value} onChangeText={setValue} />
    </View>
  );
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("covers JSX held in a variable and rendered inside the layer", () => {
    const content = `export default function S() {
  const searchRow = (
    <View style={styles.searchWrap}>
      <TextInput value={q} onChangeText={setQ} />
    </View>
  );
  return <ListScreen pinnedHeader={searchRow} items={items} />;
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("flags a helper whose render site has no layer, naming that site", () => {
    const content = `export default function S() {
  return (
    <View>
      <SearchRow value={q} onChangeText={setQ} />
    </View>
  );
}

function SearchRow({ value, onChangeText }) {
  return <TextInput value={value} onChangeText={onChangeText} />;
}
`;
    const violations = scanContent(content, SCREEN);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toContain("SearchRow");
    expect(violations[0].path).toContain("line 4");
  });

  it("flags a helper when only some of its render sites are covered", () => {
    const content = `export default function S() {
  return (
    <>
      <DismissKeyboardView>
        <SearchRow />
      </DismissKeyboardView>
      <View>
        <SearchRow />
      </View>
    </>
  );
}

function SearchRow() {
  return <TextInput value={q} onChangeText={setQ} />;
}
`;
    expect(scanContent(content, SCREEN)).toHaveLength(1);
  });

  it("flags a helper this file never renders", () => {
    const content = `export function SearchRow() {
  return <TextInput value={q} onChangeText={setQ} />;
}
`;
    const violations = scanContent(content, SCREEN);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toContain("never rendered");
  });

  it("follows a chain of helpers up to a covered render site", () => {
    const content = `export default function S() {
  return (
    <FormSheet visible={open} onClose={close}>
      <Body />
    </FormSheet>
  );
}

function Body() {
  return <Row />;
}

function Row() {
  return <TextField label="Name" value={q} onChangeText={setQ} />;
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("does not hang on helpers that render each other", () => {
    const content = `function A() {
  return <B />;
}

function B() {
  return (
    <View>
      <A />
      <TextInput value={q} onChangeText={setQ} />
    </View>
  );
}
`;
    expect(scanContent(content, SCREEN)).toHaveLength(1);
  });
});

describe("lint-mobile-keyboard-dismiss — comments decide nothing", () => {
  it("ignores a dismissal layer that is commented out with a block comment", () => {
    const content = `export default function S() {
  /*
  return (
    <DismissKeyboardView>
      <TextInput value={q} onChangeText={setQ} />
    </DismissKeyboardView>
  );
  */
  return (
    <View>
      <TextInput value={q} onChangeText={setQ} />
    </View>
  );
}
`;
    expect(scanContent(content, SCREEN)).toHaveLength(1);
  });

  it("ignores a dismissal layer commented out inside JSX", () => {
    const violations = scanContent(
      screenWith(`    <View>
      {/*
        <DismissKeyboardView>
      */}
      <TextInput value={q} onChangeText={setQ} />
    </View>`),
      SCREEN
    );
    expect(violations).toHaveLength(1);
  });

  it("ignores an input that is only mentioned in a comment", () => {
    const violations = scanContent(
      screenWith(`    <View>
      {/* <TextInput value={q} onChangeText={setQ} /> */}
      <Text>No input here</Text>
    </View>`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });

  it("ignores an input commented out mid-line", () => {
    const violations = scanContent(
      screenWith(`    <View>
      <Text>Nothing</Text> {/* was <TextInput /> */}
    </View>`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });
});

describe("lint-mobile-keyboard-dismiss — scaffold trust is re-verified", () => {
  it("accepts a scaffold that renders the caller's content inside the primitive", () => {
    const source = `export function ListScreen({ children }) {
  return <DismissKeyboardView style={styles.screen}>{children}</DismissKeyboardView>;
}
`;
    expect(providesDismissal(source, "ListScreen")).toBe(true);
  });

  it("accepts a scaffold that wires the hook to its sheet press handler", () => {
    const source = `export function FormSheet({ children }) {
  const dismissKeyboard = ${DISMISS_HOOK}();
  return (
    <Pressable onPress={dismissKeyboard} style={styles.sheet}>
      {children}
    </Pressable>
  );
}
`;
    expect(providesDismissal(source, "FormSheet")).toBe(true);
  });

  it("rejects a scaffold that calls the hook without wiring it", () => {
    const source = `export function FormSheet({ children }) {
  const dismissKeyboard = ${DISMISS_HOOK}();
  return <View style={styles.sheet}>{children}</View>;
}
`;
    expect(providesDismissal(source, "FormSheet")).toBe(false);
  });

  it("rejects a scaffold that only imports the primitive", () => {
    const source = `import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";

export function ListScreen({ children }) {
  return <View style={styles.screen}>{children}</View>;
}
`;
    expect(providesDismissal(source, "ListScreen")).toBe(false);
  });

  it("rejects a scaffold whose layer wraps a sibling instead of the caller's content", () => {
    const source = `export function ListScreen({ children }) {
  return (
    <View style={styles.screen}>
      <DismissKeyboardView>
        <Header />
      </DismissKeyboardView>
      {children}
    </View>
  );
}
`;
    expect(providesDismissal(source, "ListScreen")).toBe(false);
  });

  it("rejects a scaffold that leaves one of its slots outside the layer", () => {
    const source = `export function ListScreen({ children, pinnedHeader }) {
  return (
    <View style={styles.screen}>
      {pinnedHeader}
      <DismissKeyboardView>{children}</DismissKeyboardView>
    </View>
  );
}
`;
    expect(providesDismissal(source, "ListScreen")).toBe(false);
  });

  it("rejects a scaffold whose layer sits outside the modal it renders content into", () => {
    const source = `export function FormSheet({ children }) {
  return (
    <DismissKeyboardView>
      <Modal visible={visible}>{children}</Modal>
    </DismissKeyboardView>
  );
}
`;
    expect(providesDismissal(source, "FormSheet")).toBe(false);
  });

  it("accepts a modal scaffold whose layer is inside the modal, above the content", () => {
    const source = `export function FormSheet({ children }) {
  return (
    <Modal visible={visible}>
      <DismissKeyboardView style={styles.sheet}>{children}</DismissKeyboardView>
    </Modal>
  );
}
`;
    expect(providesDismissal(source, "FormSheet")).toBe(true);
  });

  it("accepts a scaffold that renders its row renderer under the layer itself", () => {
    const source = `export function ListScreen({ renderItem, items }) {
  return (
    <DismissKeyboardView style={styles.screen}>
      {items.map((item) => renderItem(item))}
    </DismissKeyboardView>
  );
}
`;
    expect(providesDismissal(source, "ListScreen")).toBe(true);
  });

  it("rejects a scaffold that only hands the caller's content to another component", () => {
    // Passing a slot on as a prop proves nothing here: where that content ends
    // up is the other component's business, and this check cannot see inside
    // it. A screen may rely on `<ListScreen pinnedHeader={...} />` precisely
    // because ListScreen itself is verified below to render its slots under a
    // layer — trust has to start somewhere that renders.
    const source = `export function ListScreen({ renderItem, items }) {
  return (
    <FlatList
      data={items}
      keyboardDismissMode={scrollKeyboardDismissMode}
      renderItem={({ item }) => renderItem(item)}
    />
  );
}
`;
    expect(providesDismissal(source, "ListScreen")).toBe(false);
  });

  it("rejects a scaffold that renders none of the content it is given", () => {
    const source = `export function ListScreen({ children }) {
  return <DismissKeyboardView style={styles.screen} />;
}
`;
    expect(providesDismissal(source, "ListScreen")).toBe(false);
  });

  it("rejects a scaffold whose component is not in the file it is claimed to live in", () => {
    const source = `export function SomethingElse({ children }) {
  return <DismissKeyboardView>{children}</DismissKeyboardView>;
}
`;
    expect(providesDismissal(source, "ListScreen")).toBe(false);
  });

  it("holds the real scaffolds to the same rule", () => {
    for (const scaffold of DISMISSAL_SCAFFOLDS) {
      const source = readFileSync(
        join(MOBILE_APP, ...scaffold.source.split("/")),
        "utf8"
      );
      expect(providesDismissal(source, scaffold.component, scaffold.source)).toBe(true);
    }
  });
});

describe("lint-mobile-keyboard-dismiss — a <Modal> is its own touch tree", () => {
  it("flags an input in a modal that the screen's layer only appears to cover", () => {
    const violations = scanContent(
      screenWith(`    <DismissKeyboardView>
      <Modal visible={pickerVisible} transparent>
        <View style={styles.modalSheet}>
          <TextInput value={filter} onChangeText={setFilter} />
        </View>
      </Modal>
    </DismissKeyboardView>`),
      SCREEN
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toContain("<Modal>");
    expect(violations[0].reason).toContain("<Modal>");
  });

  it("accepts an input in a modal that carries its own layer", () => {
    const violations = scanContent(
      screenWith(`    <DismissKeyboardView>
      <Modal visible={pickerVisible} transparent>
        <DismissKeyboardView style={styles.modalSheet}>
          <TextInput value={filter} onChangeText={setFilter} />
        </DismissKeyboardView>
      </Modal>
    </DismissKeyboardView>`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });

  it("accepts a modal sheet that dismisses through its own press handler", () => {
    const content = `import { ${DISMISS_HOOK} } from "@/components/ui/DismissKeyboardView";

export default function S() {
  const dismissKeyboard = ${DISMISS_HOOK}();
  return (
    <Modal visible={open} transparent>
      <Pressable style={styles.sheet} onPress={dismissKeyboard}>
        <TextInput value={filter} onChangeText={setFilter} />
      </Pressable>
    </Modal>
  );
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("flags a helper rendered into a modal even when its other render site is covered", () => {
    const content = `export default function S() {
  return (
    <DismissKeyboardView>
      <FilterRow />
      <Modal visible={open}>
        <View style={styles.sheet}>
          <FilterRow />
        </View>
      </Modal>
    </DismissKeyboardView>
  );
}

function FilterRow() {
  return <TextInput value={filter} onChangeText={setFilter} />;
}
`;
    const violations = scanContent(content, SCREEN);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toContain("<Modal>");
  });

  it("still sees a modal imported under another name", () => {
    const content = `import { Modal as RNModal } from "react-native";

export default function S() {
  return (
    <DismissKeyboardView>
      <RNModal visible={open}>
        <TextInput value={filter} onChangeText={setFilter} />
      </RNModal>
    </DismissKeyboardView>
  );
}
`;
    expect(scanContent(content, SCREEN)).toHaveLength(1);
  });
});

describe("lint-mobile-keyboard-dismiss — components are matched under their local names", () => {
  it("flags an uncovered input imported under an alias", () => {
    const content = `import { TextInput as RNTextInput } from "react-native";

export default function S() {
  return (
    <View>
      <RNTextInput value={q} onChangeText={setQ} />
    </View>
  );
}
`;
    const violations = scanContent(content, SCREEN);
    expect(violations).toHaveLength(1);
    expect(violations[0].component).toBe("RNTextInput");
  });

  it("accepts an aliased input that sits inside a layer", () => {
    const content = `import { TextInput as RNTextInput } from "react-native";

export default function S() {
  return (
    <DismissKeyboardView>
      <RNTextInput value={q} onChangeText={setQ} />
    </DismissKeyboardView>
  );
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("accepts a dismissal layer imported under an alias", () => {
    const content = `import { DismissKeyboardView as Dismiss } from "@/components/ui/DismissKeyboardView";

export default function S() {
  return (
    <Dismiss style={styles.screen}>
      <TextInput value={q} onChangeText={setQ} />
    </Dismiss>
  );
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("accepts the hook imported under an alias", () => {
    const content = `import { ${DISMISS_HOOK} as useDismiss } from "@/components/ui/DismissKeyboardView";

export default function S() {
  const dismiss = useDismiss();
  return (
    <Pressable onPress={dismiss} style={styles.sheet}>
      <TextInput value={q} onChangeText={setQ} />
    </Pressable>
  );
}
`;
    expect(scanContent(content, SCREEN)).toEqual([]);
  });

  it("reads a namespaced scrollable as a scrollable", () => {
    const violations = scanContent(
      screenWith(`    <Animated.ScrollView keyboardDismissMode="on-drag">
      <TextInput value={q} onChangeText={setQ} />
    </Animated.ScrollView>`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });
});

describe("lint-mobile-keyboard-dismiss — exceptions and configuration", () => {
  it("skips a file listed as an exception", () => {
    const content = screenWith(`    <TextInput value={q} onChangeText={setQ} />`);
    for (const exception of EXCEPTIONS) {
      expect(scanContent(content, exception.file)).toEqual([]);
    }
    expect(isExcepted(SCREEN)).toBeUndefined();
  });

  it("gives every exception a reason", () => {
    for (const exception of EXCEPTIONS) {
      expect(exception.file).toMatch(/^artifacts\/labtrax\/app\//);
      expect(exception.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps every trusted scaffold in the dismissal list", () => {
    for (const scaffold of DISMISSAL_SCAFFOLDS) {
      expect(DISMISSAL_COMPONENTS).toContain(scaffold.component);
      expect(scaffold.source).toMatch(/\.tsx$/);
    }
  });

  it("watches the project's text-input wrappers, not just the primitive", () => {
    expect(TEXT_INPUT_COMPONENTS).toContain("TextInput");
    expect(TEXT_INPUT_COMPONENTS).toContain("TextField");
    expect(TEXT_INPUT_COMPONENTS).toContain("SuggestionInput");
  });

  it("ignores screens with no text input at all", () => {
    const violations = scanContent(
      screenWith(`    <View>
      <Text>Read-only screen</Text>
    </View>`),
      SCREEN
    );
    expect(violations).toEqual([]);
  });
});

/**
 * A throwaway mobile app on disk: `app/` holds routes, `components/` holds
 * everything they delegate to. This is how the cross-file half of the check is
 * exercised — a route that hands its whole screen to an imported component is
 * the shape the mobile app actually uses, and it cannot be expressed in a
 * single file.
 */
class FixtureApp {
  readonly root = mkdtempSync(join(tmpdir(), "kbguard-"));

  file(relPath: string, source: string): FixtureApp {
    const full = join(this.root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source, "utf8");
    return this;
  }

  scan(): Violation[] {
    const roots: ScanRoots = { appRoot: this.root, routesDir: join(this.root, "app") };
    return MobileApp.fromDisk(["app", "components"], roots).scan();
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

const fixtures: FixtureApp[] = [];

function fixtureApp(): FixtureApp {
  const app = new FixtureApp();
  fixtures.push(app);
  return app;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

const SEARCH_ROW = `import React from "react";
import { View, TextInput } from "react-native";

export function SearchRow() {
  return (
    <View>
      <TextInput value="" onChangeText={() => {}} placeholder="Search" />
    </View>
  );
}
`;

describe("lint-mobile-keyboard-dismiss — a route that delegates its screen", () => {
  it("flags an input in an imported component the route leaves uncovered", () => {
    const violations = fixtureApp()
      .file("components/SearchRow.tsx", SEARCH_ROW)
      .file(
        "app/portal.tsx",
        `import React from "react";
import { View } from "react-native";
import { SearchRow } from "@/components/SearchRow";

export default function PortalRoute() {
  return (
    <View>
      <SearchRow />
    </View>
  );
}
`
      )
      .scan();

    expect(violations).toHaveLength(1);
    expect(violations[0].file).toContain("components/SearchRow.tsx");
    // The path has to name the route, since that is where the fix goes.
    expect(violations[0].path).toContain("app/portal.tsx");
    expect(violations[0].path).toContain("nothing containing it dismisses the keyboard");
  });

  it("passes once the route wraps the component it delegates to", () => {
    const violations = fixtureApp()
      .file("components/SearchRow.tsx", SEARCH_ROW)
      .file(
        "app/portal.tsx",
        `import React from "react";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";
import { SearchRow } from "@/components/SearchRow";

export default function PortalRoute() {
  return (
    <DismissKeyboardView>
      <SearchRow />
    </DismissKeyboardView>
  );
}
`
      )
      .scan();

    expect(violations).toEqual([]);
  });

  it("follows the delegation through a barrel and several components deep", () => {
    const app = fixtureApp()
      .file("components/sections/SearchRow.tsx", SEARCH_ROW)
      .file("components/sections/index.ts", `export { SearchRow } from "./SearchRow";\n`)
      .file(
        "components/Shell.tsx",
        `import React from "react";
import { View } from "react-native";
import { SearchRow } from "./sections";

export function Shell() {
  return (
    <View>
      <SearchRow />
    </View>
  );
}
`
      );

    app.file(
      "app/portal.tsx",
      `import React from "react";
import { Shell } from "@/components/Shell";

export default function PortalRoute() {
  return <Shell />;
}
`
    );
    const uncovered = app.scan();
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0].path).toContain("Shell");

    const covered = fixtureApp()
      .file("components/sections/SearchRow.tsx", SEARCH_ROW)
      .file("components/sections/index.ts", `export { SearchRow } from "./SearchRow";\n`)
      .file(
        "components/Shell.tsx",
        `import React from "react";
import { View } from "react-native";
import { SearchRow } from "./sections";

export function Shell() {
  return (
    <View>
      <SearchRow />
    </View>
  );
}
`
      )
      .file(
        "app/portal.tsx",
        `import React from "react";
import { StyleSheet } from "react-native";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";
import { Shell } from "@/components/Shell";

export default function PortalRoute() {
  return (
    <DismissKeyboardView style={styles.fill}>
      <Shell />
    </DismissKeyboardView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
`
      )
      .scan();

    expect(covered).toEqual([]);
  });

  it("fails when only one of a component's two render sites is covered", () => {
    const violations = fixtureApp()
      .file("components/SearchRow.tsx", SEARCH_ROW)
      .file(
        "app/covered.tsx",
        `import React from "react";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";
import { SearchRow } from "@/components/SearchRow";

export default function CoveredRoute() {
  return (
    <DismissKeyboardView>
      <SearchRow />
    </DismissKeyboardView>
  );
}
`
      )
      .file(
        "app/bare.tsx",
        `import React from "react";
import { View } from "react-native";
import { SearchRow } from "@/components/SearchRow";

export default function BareRoute() {
  return (
    <View>
      <SearchRow />
    </View>
  );
}
`
      )
      .scan();

    expect(violations).toHaveLength(1);
    expect(violations[0].path).toContain("app/bare.tsx");
  });

  it("still treats a Modal as a boundary across files", () => {
    const violations = fixtureApp()
      .file(
        "components/PaySheet.tsx",
        `import React from "react";
import { Modal, View, TextInput } from "react-native";

export function PaySheet() {
  return (
    <Modal visible transparent>
      <View>
        <TextInput value="" onChangeText={() => {}} keyboardType="decimal-pad" />
      </View>
    </Modal>
  );
}
`
      )
      .file(
        "app/billing.tsx",
        `import React from "react";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";
import { PaySheet } from "@/components/PaySheet";

export default function BillingRoute() {
  return (
    <DismissKeyboardView>
      <PaySheet />
    </DismissKeyboardView>
  );
}
`
      )
      .scan();

    // The route's layer is real, but a modal renders in its own touch tree.
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toContain("<Modal>");
  });

  it("passes when the modal sheet carries its own layer", () => {
    const violations = fixtureApp()
      .file(
        "components/PaySheet.tsx",
        `import React from "react";
import { Modal, TextInput } from "react-native";
import { DismissKeyboardView } from "@/components/ui/DismissKeyboardView";

export function PaySheet() {
  return (
    <Modal visible transparent>
      <DismissKeyboardView>
        <TextInput value="" onChangeText={() => {}} keyboardType="decimal-pad" />
      </DismissKeyboardView>
    </Modal>
  );
}
`
      )
      .file(
        "app/billing.tsx",
        `import React from "react";
import { PaySheet } from "@/components/PaySheet";

export default function BillingRoute() {
  return <PaySheet />;
}
`
      )
      .scan();

    expect(violations).toEqual([]);
  });

  it("flags a component with an input that no route reaches at all", () => {
    const violations = fixtureApp().file("components/SearchRow.tsx", SEARCH_ROW).scan();

    expect(violations).toHaveLength(1);
    expect(violations[0].path).toContain("never rendered");
  });

  it("answers for a text-input wrapper at its call sites, not inside its own definition", () => {
    const violations = fixtureApp()
      .file(
        "components/ui/TextField.tsx",
        `import React from "react";
import { View, Text, TextInput } from "react-native";

export function TextField({ label, value, onChangeText }) {
  return (
    <View>
      <Text>{label}</Text>
      <TextInput value={value} onChangeText={onChangeText} />
    </View>
  );
}
`
      )
      .file(
        "app/edit.tsx",
        `import React from "react";
import { View } from "react-native";
import { TextField } from "@/components/ui/TextField";

export default function EditRoute() {
  return (
    <View>
      <TextField label="Name" value="" onChangeText={() => {}} />
    </View>
  );
}
`
      )
      .scan();

    // One violation, reported where the wrapper is used — the wrapper's own
    // <TextInput> is not a second finding for the same trapped keyboard.
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toContain("app/edit.tsx");
    expect(violations[0].component).toBe("TextField");
  });
});
