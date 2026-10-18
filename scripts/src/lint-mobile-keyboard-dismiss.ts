#!/usr/bin/env tsx
/**
 * Mobile keyboard-dismissal guard.
 *
 * Every mobile screen that renders a text input must give the user a way to
 * close the soft keyboard. Otherwise the keyboard covers the content with no
 * obvious way out — the bug this convention was introduced to fix. This guard
 * makes the convention self-enforcing: a text input anywhere in the mobile app
 * fails the build unless something that actually contains it dismisses the
 * keyboard.
 *
 * The check parses the mobile source as TSX and walks the JSX tree, so it
 * tests containment rather than the presence of a token: a scaffold rendered
 * next to an input does not protect that input, a hook called but never wired
 * to a press handler protects nothing, and anything inside a comment is
 * invisible to the parser.
 *
 * Route files rarely hold the input themselves — `app/provider/portal.tsx`
 * renders `<ProviderPortalShell />`, and the fields live several components
 * away. So the guard follows the module graph: an input inside a component is
 * covered when *every* place the app renders that component is itself covered,
 * across files, through barrels and aliased imports. One uncovered render site
 * fails, and a component nothing renders cannot be proven and fails too.
 *
 * A text input is `<TextInput>` (the React Native primitive) or one of the
 * project wrappers around it, `<TextField>` and `<SuggestionInput>` — under
 * whatever local name a file imports it as. The wrappers' own definitions are
 * skipped: they are answered for wherever they are rendered.
 *
 * An input is covered when one of its JSX ancestors is:
 *   - `<DismissKeyboardView>` — the primitive; wrap the screen body once.
 *   - `<ListScreen>`  — list scaffold, already wrapped.
 *   - `<FormSheet>`   — bottom-sheet editor scaffold, already wrapped.
 *   - `<ScreenShell>` — settings screen shell, already wrapped.
 *   - an element whose press handler is wired to `useDismissKeyboardOnTap()`
 *     — for a screen whose own full-bleed Pressable must keep its handler
 *     (e.g. a sheet body that also swallows backdrop taps).
 *   - a scrollable (`ScrollView`, `FlatList`, and friends) carrying
 *     `keyboardDismissMode` — the drag affordance the primitive documents as
 *     the tap layer's pair. The prop only counts on a real scrollable; on a
 *     plain `View` it does nothing.
 *
 * `<Modal>` ends the search. A modal renders in its own touch tree, so a layer
 * outside it cannot close the keyboard for an input inside it: a modal body
 * with a text input has to carry its own dismissal.
 *
 * An ancestor includes an element the input is passed to as a prop
 * (`<ListScreen pinnedHeader={<SearchRow />} />`), because the scaffold renders
 * that element inside its own dismissal layer.
 *
 * The scaffolds are re-verified against their own sources on every run, and by
 * the same containment rule: each scaffold has to render the slots its callers
 * fill — `children`, a pinned header, a row renderer — underneath its own
 * dismissal layer. Moving that layer off to one side fails here instead of
 * silently unprotecting every screen built on the scaffold.
 *
 * Deliberate exceptions live in `EXCEPTIONS` below, each with the reason it is
 * safe. The guard also fails on an exception that is no longer needed, so the
 * list cannot rot.
 *
 * Wire this into CI:
 *   pnpm --filter @workspace/scripts run lint-mobile-keyboard-dismiss
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// The compiler is the workspace-wide toolchain dependency, pinned once at the
// repo root like it is for every package here that runs `tsc`.
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const MOBILE_APP = path.resolve(REPO_ROOT, "artifacts", "labtrax");
const ROUTES_DIR = path.resolve(MOBILE_APP, "app");

/** Where the mobile UI lives. Everything here is parsed; the `.tsx` is scanned. */
const SOURCE_DIRS: ReadonlyArray<string> = ["app", "components", "lib", "constants"];

/**
 * The tree being checked. The real run points at the mobile app; the tests
 * point at a fixture tree, which is how cross-file behaviour — a route that
 * delegates its screen to an imported component — is exercised without
 * writing files into the app itself.
 */
export interface ScanRoots {
  /** What `@/` resolves against, and the root the scan walks. */
  appRoot: string;
  /** Files under here are routes: the router renders their default export. */
  routesDir: string;
}

export const MOBILE_ROOTS: ScanRoots = { appRoot: MOBILE_APP, routesDir: ROUTES_DIR };

const SKIPPED_DIRS: ReadonlyArray<string> = [
  "node_modules",
  "__tests__",
  "__mocks__",
  "test-stubs",
  "attached_assets",
  "build",
  "dist",
];

/** Components that put a soft keyboard on screen. */
export const TEXT_INPUT_COMPONENTS: ReadonlyArray<string> = [
  "TextInput",
  "TextField",
  "SuggestionInput",
];

/** Components that dismiss the keyboard for everything they contain. */
export const DISMISSAL_COMPONENTS: ReadonlyArray<string> = [
  "DismissKeyboardView",
  "ListScreen",
  "FormSheet",
  "ScreenShell",
];

export const DISMISS_HOOK = "useDismissKeyboardOnTap";

/**
 * Scaffolds trusted above, and the source that has to keep earning that trust.
 * `DismissKeyboardView` is not listed: it is the primitive itself.
 */
export const DISMISSAL_SCAFFOLDS: ReadonlyArray<{
  component: string;
  source: string;
}> = [
  { component: "ListScreen", source: "components/ui/ListScreen.tsx" },
  { component: "FormSheet", source: "components/ui/FormSheet.tsx" },
  { component: "ScreenShell", source: "components/settings/SettingsRow.tsx" },
];

/**
 * A modal renders in its own touch tree, detached from where it sits in the
 * JSX. Dismissal has to come from inside it.
 */
const MODAL_COMPONENTS: ReadonlyArray<string> = ["Modal"];

/** Scrollables, the only elements on which `keyboardDismissMode` does anything. */
const SCROLLABLE_COMPONENTS: ReadonlyArray<string> = [
  "ScrollView",
  "FlatList",
  "SectionList",
  "VirtualizedList",
  "FlashList",
  "KeyboardAwareScrollView",
  "KeyboardAwareFlatList",
];

/** Props through which a dismiss handler reaches the user's tap. */
const PRESS_PROPS: ReadonlyArray<string> = [
  "onPress",
  "onPressIn",
  "onLongPress",
  "onTouchStart",
  "onStartShouldSetResponder",
];

const SCROLL_DISMISS_PROP = "keyboardDismissMode";
const SCROLL_DISMISS_VALUES: ReadonlyArray<string> = ["interactive", "on-drag"];
const SCROLL_DISMISS_CONSTANT = "scrollKeyboardDismissMode";

export interface Exception {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** Why this file is safe without a dismissal layer. */
  reason: string;
}

/**
 * Deliberate exceptions. Add one only when the file genuinely cannot trap a
 * keyboard — not to silence a screen that simply has not been wrapped yet.
 *
 * Empty today: every text input in the mobile app sits inside a dismissal
 * layer, directly or through the component that renders it.
 */
export const EXCEPTIONS: ReadonlyArray<Exception> = [];

export interface Violation {
  file: string;
  line: number;
  column: number;
  /** The text-input component that is left uncovered. */
  component: string;
  text: string;
  /** Where coverage breaks down: the render path that reaches no layer. */
  path: string;
  reason: string;
}

const REASON =
  "This text input has no way to close the keyboard: nothing containing it is " +
  "<DismissKeyboardView>, a scaffold that wraps one (<ListScreen>, <FormSheet>, " +
  "<ScreenShell>), an element whose press handler is wired to " +
  `${DISMISS_HOOK}(), or a scrollable that dismisses on drag. Wrap the screen ` +
  "body once, as high as possible, in <DismissKeyboardView> — and pair it with " +
  "scrollKeyboardDismissMode on the screen's scrollable so a drag dismisses too. " +
  "A <Modal> needs its own layer around its sheet content: it renders in its own " +
  "touch tree, so the screen's layer cannot reach inside it.";

function parseTsx(content: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
}

function eachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

type JsxOpening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function isJsxOpening(node: ts.Node): node is JsxOpening {
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
}

function tagNameOf(element: JsxOpening): string {
  return element.tagName.getText(element.getSourceFile());
}

/** `Animated.ScrollView` is a ScrollView; `styles.Foo` never names a component. */
function tagSegments(element: JsxOpening): string[] {
  const text = tagNameOf(element);
  const last = text.split(".").pop() ?? text;
  return text === last ? [text] : [text, last];
}

/**
 * The names this file uses for the components the guard cares about. Imports
 * are followed, so `import { TextInput as RNTextInput }` is still an input and
 * `import { DismissKeyboardView as Dismiss }` still dismisses.
 */
interface LocalNames {
  inputs: Set<string>;
  dismissal: Set<string>;
  hooks: Set<string>;
  scrollables: Set<string>;
  modals: Set<string>;
}

function collectLocalNames(sourceFile: ts.SourceFile): LocalNames {
  const names: LocalNames = {
    inputs: new Set(TEXT_INPUT_COMPONENTS),
    dismissal: new Set(DISMISSAL_COMPONENTS),
    hooks: new Set([DISMISS_HOOK]),
    scrollables: new Set(SCROLLABLE_COMPONENTS),
    modals: new Set(MODAL_COMPONENTS),
  };

  eachNode(sourceFile, (node) => {
    if (!ts.isImportSpecifier(node)) return;
    const imported = (node.propertyName ?? node.name).text;
    const local = node.name.text;
    if (local === imported) return;
    if (names.inputs.has(imported)) names.inputs.add(local);
    if (names.dismissal.has(imported)) names.dismissal.add(local);
    if (names.hooks.has(imported)) names.hooks.add(local);
    if (names.scrollables.has(imported)) names.scrollables.add(local);
    if (names.modals.has(imported)) names.modals.add(local);
  });

  return names;
}

function matchesName(element: JsxOpening, known: ReadonlySet<string>): boolean {
  return tagSegments(element).some((segment) => known.has(segment));
}

function isDismissHookCall(node: ts.Node, names: LocalNames): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    names.hooks.has(node.expression.text)
  );
}

/** Names bound to the hook's return value: `const dismiss = useDismissKeyboardOnTap()`. */
function collectDismissHandles(sourceFile: ts.SourceFile, names: LocalNames): Set<string> {
  const handles = new Set<string>();
  eachNode(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isDismissHookCall(node.initializer, names) &&
      ts.isIdentifier(node.name)
    ) {
      handles.add(node.name.text);
    }
  });
  return handles;
}

function attributeName(attribute: ts.JsxAttribute): string {
  return ts.isIdentifier(attribute.name)
    ? attribute.name.text
    : attribute.name.getText(attribute.getSourceFile());
}

function findAttribute(element: JsxOpening, name: string): ts.JsxAttribute | undefined {
  for (const attribute of element.attributes.properties) {
    if (ts.isJsxAttribute(attribute) && attributeName(attribute) === name) return attribute;
  }
  return undefined;
}

/** Does this element hand a dismiss handler to one of its press props? */
function wiresDismissHandler(
  element: JsxOpening,
  handles: ReadonlySet<string>,
  names: LocalNames
): boolean {
  for (const prop of PRESS_PROPS) {
    const attribute = findAttribute(element, prop);
    const initializer = attribute?.initializer;
    if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) continue;

    let wired = false;
    eachNode(initializer.expression, (node) => {
      if (wired) return;
      if (isDismissHookCall(node, names)) wired = true;
      else if (ts.isIdentifier(node) && handles.has(node.text)) wired = true;
    });
    if (wired) return true;
  }
  return false;
}

/**
 * Does dragging this element close the keyboard? Only a scrollable can: the
 * prop is inert on anything else.
 */
function dismissesOnScroll(element: JsxOpening, names: LocalNames): boolean {
  if (!matchesName(element, names.scrollables)) return false;

  const initializer = findAttribute(element, SCROLL_DISMISS_PROP)?.initializer;
  if (!initializer) return false;
  if (ts.isStringLiteral(initializer)) {
    return SCROLL_DISMISS_VALUES.includes(initializer.text);
  }
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return false;

  let dismisses = false;
  eachNode(initializer.expression, (node) => {
    if (dismisses) return;
    if (ts.isIdentifier(node) && node.text === SCROLL_DISMISS_CONSTANT) dismisses = true;
    else if (ts.isStringLiteral(node) && SCROLL_DISMISS_VALUES.includes(node.text)) {
      dismisses = true;
    }
  });
  return dismisses;
}

function openingElementOf(node: ts.Node): JsxOpening | undefined {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return undefined;
}

/**
 * The nearest thing containing this node that dismisses the keyboard, if there
 * is one. A `<Modal>` ends the walk: its content renders in a separate touch
 * tree, so layers outside it never see the tap.
 */
function findCoveringAncestor(
  input: ts.Node,
  handles: ReadonlySet<string>,
  names: LocalNames
): string | undefined {
  for (let node = input.parent; node; node = node.parent) {
    const opening = openingElementOf(node);
    if (!opening) continue;

    const name = tagNameOf(opening);
    if (matchesName(opening, names.dismissal)) return `<${name}>`;
    if (wiresDismissHandler(opening, handles, names)) return `${DISMISS_HOOK}() on <${name}>`;
    if (dismissesOnScroll(opening, names)) return `${SCROLL_DISMISS_PROP} on <${name}>`;
    if (matchesName(opening, names.modals)) return undefined;
  }
  return undefined;
}

/** Did the search stop because a modal boundary cut it short? */
function insideModal(input: ts.Node, names: LocalNames): boolean {
  for (let node = input.parent; node; node = node.parent) {
    const opening = openingElementOf(node);
    if (opening && matchesName(opening, names.modals)) return true;
  }
  return false;
}

/** A named thing the JSX escapes into: `const header = ...`, `function Row()`. */
interface LocalDefinition {
  name: string;
  nameNode: ts.Identifier;
  node: ts.Node;
}

/** The innermost `const x = ...` / `function x()` the node sits inside. */
function findEnclosingDefinition(node: ts.Node): LocalDefinition | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return { name: current.name.text, nameNode: current.name, node: current };
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      return { name: current.name.text, nameNode: current.name, node: current };
    }
  }
  return undefined;
}

/** Is this identifier a use of a name, rather than part of its declaration? */
function isReferenceIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return false;
  // `import { x }`, `export { x }`, `x.prop`, `{ prop: value }`, and the name
  // side of any declaration are spellings of the name, not renders of it.
  if (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportAssignment(parent)
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if (ts.isQualifiedName(parent) && parent.right === identifier) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === identifier) return false;
  const named = parent as ts.NamedDeclaration;
  if (named.name === identifier) return false;
  return true;
}

/** Every use of each name in the file, indexed by name. */
function collectReferences(sourceFile: ts.SourceFile): Map<string, ts.Identifier[]> {
  const references = new Map<string, ts.Identifier[]>();
  eachNode(sourceFile, (node) => {
    if (!ts.isIdentifier(node) || !isReferenceIdentifier(node)) return;
    const existing = references.get(node.text);
    if (existing) existing.push(node);
    else references.set(node.text, [node]);
  });
  return references;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(modifiers?.some((modifier) => modifier.kind === kind));
}

/** What a module exports under a name: something it declares, or a re-export. */
type ExportTarget =
  | { kind: "local"; node: ts.Node; name: string }
  | { kind: "forward"; module: string; exportName: string };

interface Analysis {
  sourceFile: ts.SourceFile;
  names: LocalNames;
  handles: Set<string>;
  references: Map<string, ts.Identifier[]>;
}

function analyze(content: string, fileName: string): Analysis {
  const sourceFile = parseTsx(content, fileName);
  const names = collectLocalNames(sourceFile);
  return {
    sourceFile,
    names,
    handles: collectDismissHandles(sourceFile, names),
    references: collectReferences(sourceFile),
  };
}

/** One parsed file, plus the edges that connect it to the rest of the app. */
interface ModuleInfo {
  absPath: string;
  /** Repo-relative, forward slashes. */
  relFile: string;
  analysis: Analysis;
  /** Local name -> where it comes from. */
  imports: Map<string, { module: string; exportName: string }>;
  /** Export name -> what it resolves to. */
  exports: Map<string, ExportTarget>;
  /** Modules re-exported wholesale: `export * from "./sections"`. */
  starExports: string[];
  /** A file under `app/`: its default export is a route the router renders. */
  isRoute: boolean;
}

const MODULE_EXTENSIONS: ReadonlyArray<string> = [".tsx", ".ts"];

/** Resolve an import the way the app's `@/*` alias and relative paths do. */
function resolveModule(
  specifier: string,
  fromFile: string,
  roots: ScanRoots
): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = path.resolve(roots.appRoot, specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else return undefined;

  const candidates = [
    ...MODULE_EXTENSIONS.map((extension) => base + extension),
    ...MODULE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
    base,
  ];
  return candidates.find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()
  );
}

function collectImports(
  sourceFile: ts.SourceFile,
  absPath: string,
  roots: ScanRoots
): Map<string, { module: string; exportName: string }> {
  const imports = new Map<string, { module: string; exportName: string }>();
  eachNode(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const target = resolveModule(node.moduleSpecifier.text, absPath, roots);
    if (!target || !node.importClause) return;

    if (node.importClause.name) {
      imports.set(node.importClause.name.text, { module: target, exportName: "default" });
    }
    const bindings = node.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, {
          module: target,
          exportName: (element.propertyName ?? element.name).text,
        });
      }
    }
  });
  return imports;
}

function collectExports(
  sourceFile: ts.SourceFile,
  absPath: string,
  roots: ScanRoots
): { exports: Map<string, ExportTarget>; starExports: string[] } {
  const declared = new Map<string, { node: ts.Node; name: string }>();
  eachNode(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      declared.set(node.name.text, { node, name: node.name.text });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declared.set(node.name.text, { node, name: node.name.text });
    }
  });

  const exports = new Map<string, ExportTarget>();
  const starExports: string[] = [];

  eachNode(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      const name = node.name?.text ?? "default";
      exports.set(name, { kind: "local", node, name });
      if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
        exports.set("default", { kind: "local", node, name });
      }
      return;
    }
    if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        exports.set(declaration.name.text, {
          kind: "local",
          node: declaration,
          name: declaration.name.text,
        });
      }
      return;
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isIdentifier(node.expression)) {
      const target = declared.get(node.expression.text);
      if (target) exports.set("default", { kind: "local", ...target });
      return;
    }
    if (!ts.isExportDeclaration(node)) return;

    const from =
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? resolveModule(node.moduleSpecifier.text, absPath, roots)
        : undefined;

    if (!node.exportClause) {
      if (from) starExports.push(from);
      return;
    }
    if (!ts.isNamedExports(node.exportClause)) return;
    for (const element of node.exportClause.elements) {
      const source = (element.propertyName ?? element.name).text;
      if (from) {
        exports.set(element.name.text, {
          kind: "forward",
          module: from,
          exportName: source,
        });
        continue;
      }
      const target = declared.get(source);
      if (target) exports.set(element.name.text, { kind: "local", ...target });
    }
  });

  return { exports, starExports };
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function loadModule(absPath: string, roots: ScanRoots): ModuleInfo {
  const content = fs.readFileSync(absPath, "utf8");
  const relFile = relative(absPath);
  return buildModule(content, absPath, relFile, roots);
}

function buildModule(
  content: string,
  absPath: string,
  relFile: string,
  roots: ScanRoots
): ModuleInfo {
  const analysis = analyze(content, relFile);
  const { exports, starExports } = collectExports(analysis.sourceFile, absPath, roots);
  return {
    absPath,
    relFile,
    analysis,
    imports: collectImports(analysis.sourceFile, absPath, roots),
    exports,
    starExports,
    isRoute: absPath.startsWith(roots.routesDir + path.sep),
  };
}

/** Where a component is rendered: a node, and the module whose JSX holds it. */
interface RenderSite {
  module: ModuleInfo;
  node: ts.Node;
}

/**
 * The mobile app as one graph: every file, plus a reverse index from each
 * component definition to the places other files render it.
 */
export class MobileApp {
  private readonly modules = new Map<string, ModuleInfo>();
  /** Definition key -> the sites in other modules that render it. */
  private readonly externalUses = new Map<string, RenderSite[]>();

  constructor(modules: ModuleInfo[]) {
    for (const module of modules) this.modules.set(module.absPath, module);
    this.indexExternalUses();
  }

  static fromDisk(
    dirs: ReadonlyArray<string> = SOURCE_DIRS,
    roots: ScanRoots = MOBILE_ROOTS
  ): MobileApp {
    const modules: ModuleInfo[] = [];
    for (const dir of dirs) {
      for (const file of walkSources(path.resolve(roots.appRoot, dir))) {
        modules.push(loadModule(file, roots));
      }
    }
    return new MobileApp(modules);
  }

  /** Every uncovered input in the tree, in the order the files were loaded. */
  scan(): Violation[] {
    return this.scannableModules().flatMap((module) => scanModule(this, module));
  }

  /** Only `.tsx` can hold JSX, so only `.tsx` is scanned for inputs. */
  scannableModules(): ModuleInfo[] {
    return [...this.modules.values()].filter((module) => module.absPath.endsWith(".tsx"));
  }

  moduleFor(relFile: string): ModuleInfo | undefined {
    for (const module of this.modules.values()) {
      if (module.relFile === relFile) return module;
    }
    return undefined;
  }

  /** Follow `export { X } from "./y"` and `export *` to the declaration itself. */
  private resolveExport(
    absPath: string,
    exportName: string,
    seen = new Set<string>()
  ): { module: ModuleInfo; node: ts.Node; name: string } | undefined {
    const key = `${absPath}#${exportName}`;
    if (seen.has(key)) return undefined;
    seen.add(key);

    const module = this.modules.get(absPath);
    if (!module) return undefined;

    const target = module.exports.get(exportName);
    if (target?.kind === "local") return { module, node: target.node, name: target.name };
    if (target?.kind === "forward") {
      return this.resolveExport(target.module, target.exportName, seen);
    }
    for (const star of module.starExports) {
      const found = this.resolveExport(star, exportName, seen);
      if (found) return found;
    }
    return undefined;
  }

  private static definitionKey(module: ModuleInfo, node: ts.Node): string {
    return `${module.absPath}#${node.pos}`;
  }

  private indexExternalUses(): void {
    for (const module of this.modules.values()) {
      for (const [local, source] of module.imports) {
        const target = this.resolveExport(source.module, source.exportName);
        if (!target) continue;
        const key = MobileApp.definitionKey(target.module, target.node);
        const uses = module.analysis.references.get(local) ?? [];
        if (uses.length === 0) continue;
        const existing = this.externalUses.get(key);
        const sites = uses.map((node) => ({ module, node }));
        if (existing) existing.push(...sites);
        else this.externalUses.set(key, sites);
      }
    }
  }

  /** Everywhere this definition is rendered: in its own file and across the app. */
  renderSites(module: ModuleInfo, definition: LocalDefinition): RenderSite[] {
    const own = (module.analysis.references.get(definition.name) ?? [])
      .filter((identifier) => identifier !== definition.nameNode)
      .map((node) => ({ module, node }));
    const external = this.externalUses.get(MobileApp.definitionKey(module, definition.node)) ?? [];
    return [...own, ...external];
  }

  /** Is this the root of a route? Nothing renders it in app code — the router does. */
  isRouteRoot(module: ModuleInfo, definition: LocalDefinition): boolean {
    if (!module.isRoute) return false;
    const exported = module.exports.get("default");
    return exported?.kind === "local" && exported.node === definition.node;
  }

  /** Is this definition one of the project's text-input wrappers? */
  isInputWrapper(definition: LocalDefinition): boolean {
    return TEXT_INPUT_COMPONENTS.includes(definition.name);
  }
}

/** How deep a chain of components rendering components the guard will follow. */
const MAX_RENDER_DEPTH = 24;

/** What a render site that reaches no dismissal layer should be called. */
function describeDeadEnd(node: ts.Node, module: ModuleInfo): string {
  return insideModal(node, module.analysis.names)
    ? "it is inside a <Modal> that carries no dismissal layer of its own"
    : "nothing containing it dismisses the keyboard";
}

function describeSite(site: RenderSite, from: ModuleInfo): string {
  const { line } = site.module.analysis.sourceFile.getLineAndCharacterOfPosition(
    site.node.getStart(site.module.analysis.sourceFile)
  );
  return site.module === from
    ? `line ${line + 1}`
    : `${site.module.relFile}:${line + 1}`;
}

/**
 * Is this node rendered inside a dismissal layer? Directly, or — when the JSX
 * around it escapes into a component — at every place the app renders that
 * component, in this file or any other. A component nothing renders cannot be
 * proven covered.
 *
 * Returns nothing when covered, and otherwise the render path that is not,
 * which is what a developer needs to fix it.
 */
function whyUncovered(
  app: MobileApp,
  module: ModuleInfo,
  node: ts.Node,
  seen: ReadonlySet<ts.Node>
): string | undefined {
  const { handles, names } = module.analysis;
  if (findCoveringAncestor(node, handles, names)) return undefined;

  // A modal renders in its own touch tree. Nothing at an outer render site can
  // reach into it, so the search ends here instead of escalating: a layer
  // around `<PaySheet />` does not cover the fields inside the sheet's modal.
  if (insideModal(node, names)) return describeDeadEnd(node, module);

  const definition = findEnclosingDefinition(node);
  if (!definition || app.isRouteRoot(module, definition)) {
    return describeDeadEnd(node, module);
  }
  if (seen.has(definition.node) || seen.size >= MAX_RENDER_DEPTH) {
    return `\`${definition.name}\` renders in a cycle this check cannot follow`;
  }

  const sites = app.renderSites(module, definition);
  if (sites.length === 0) {
    return `\`${definition.name}\` is never rendered anywhere this check can see, so no render site can be checked`;
  }

  const deeper = new Set(seen).add(definition.node);
  for (const site of sites) {
    const failure = whyUncovered(app, site.module, site.node, deeper);
    if (!failure) continue;
    return `\`${definition.name}\` is rendered at ${describeSite(site, module)}, where ${failure}`;
  }
  return undefined;
}

/** Scan one already-parsed module for inputs that cannot close the keyboard. */
export function scanModule(app: MobileApp, module: ModuleInfo): Violation[] {
  if (isExcepted(module.relFile)) return [];

  const { sourceFile, names } = module.analysis;
  const lines = sourceFile.getFullText().split(/\r?\n/);
  const violations: Violation[] = [];

  eachNode(sourceFile, (node) => {
    if (!isJsxOpening(node)) return;
    if (!matchesName(node, names.inputs)) return;
    // A wrapper's own `<TextInput>` is answered for wherever the wrapper is
    // rendered, which is checked under the wrapper's own name.
    const definition = findEnclosingDefinition(node);
    if (definition && app.isInputWrapper(definition)) return;

    const failure = whyUncovered(app, module, node, new Set());
    if (!failure) return;

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile)
    );
    const raw = (lines[line] ?? "").trim();
    violations.push({
      file: module.relFile,
      line: line + 1,
      column: character + 1,
      component: tagNameOf(node),
      text: raw.length > 160 ? `${raw.slice(0, 157)}...` : raw,
      path: failure,
      reason: REASON,
    });
  });

  return violations;
}

/**
 * Scan one file's source in isolation, with no module graph around it. Used by
 * the unit tests and by the exception staleness check; the real run goes
 * through `MobileApp.fromDisk()` so components are followed across files.
 */
export function scanContent(content: string, relFile: string): Violation[] {
  if (isExcepted(relFile)) return [];
  const absPath = path.resolve(REPO_ROOT, relFile);
  const module = buildModule(content, absPath, relFile, MOBILE_ROOTS);
  return scanModule(new MobileApp([module]), module);
}

/** The component declaration a scaffold is named after. */
function findComponent(
  sourceFile: ts.SourceFile,
  componentName: string
): ts.FunctionDeclaration | ts.VariableDeclaration | undefined {
  let found: ts.FunctionDeclaration | ts.VariableDeclaration | undefined;
  eachNode(sourceFile, (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === componentName) found = node;
    else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === componentName &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      found = node;
    }
  });
  return found;
}

/** The prop names a component destructures: `function ListScreen({ title, children })`. */
function destructuredProps(
  component: ts.FunctionDeclaration | ts.VariableDeclaration
): Set<string> {
  const props = new Set<string>();
  const fn = ts.isFunctionDeclaration(component)
    ? component
    : (component.initializer as ts.ArrowFunction | ts.FunctionExpression | undefined);
  const parameter = fn?.parameters[0];
  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) return props;
  for (const element of parameter.name.elements) {
    if (ts.isIdentifier(element.name)) props.add(element.name.text);
  }
  return props;
}

/** Text content cannot hold an input, so `<Text>{title}</Text>` is not a slot. */
function insideTextElement(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    const opening = openingElementOf(current);
    if (opening && tagSegments(opening).includes("Text")) return true;
  }
  return false;
}

/**
 * The places a component renders what its callers gave it: `{children}`,
 * `{pinnedHeader}`, `{renderItem(item)}`. Attribute values are excluded — those
 * are handed to another component, which answers for them itself.
 */
function findSlotRenders(
  component: ts.FunctionDeclaration | ts.VariableDeclaration,
  props: ReadonlySet<string>
): ts.JsxExpression[] {
  const slots: ts.JsxExpression[] = [];
  eachNode(component, (node) => {
    if (!ts.isJsxExpression(node) || !node.expression) return;
    const parent = node.parent;
    if (!parent || (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent))) return;
    if (insideTextElement(node)) return;

    let rendersProp = false;
    eachNode(node.expression, (inner) => {
      if (rendersProp) return;
      if (ts.isIdentifier(inner) && props.has(inner.text) && isReferenceIdentifier(inner)) {
        rendersProp = true;
      }
    });
    if (rendersProp) slots.push(node);
  });
  return slots;
}

/**
 * Does this scaffold dismiss the keyboard for the content its callers pass in?
 * Not "is there a layer somewhere in the file" — every slot the component
 * renders has to sit underneath one.
 */
export function providesDismissal(
  content: string,
  componentName: string,
  fileName = "scaffold.tsx"
): boolean {
  const analysis = analyze(content, fileName);
  const component = findComponent(analysis.sourceFile, componentName);
  if (!component) return false;

  const slots = findSlotRenders(component, destructuredProps(component));
  if (slots.length === 0) return false;
  return slots.every((slot) =>
    Boolean(findCoveringAncestor(slot, analysis.handles, analysis.names))
  );
}

export function isExcepted(relFile: string): Exception | undefined {
  const normalized = relFile.split(path.sep).join("/");
  return EXCEPTIONS.find((exception) => exception.file === normalized);
}

function* walkSources(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.includes(entry.name) || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSources(full);
    } else if (
      entry.isFile() &&
      /\.(tsx|ts)$/.test(entry.name) &&
      !/\.(test|spec)\.(tsx|ts)$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name)
    ) {
      yield full;
    }
  }
}

/** A scaffold that stopped dismissing would silently unprotect every screen on it. */
function findBrokenScaffolds(): string[] {
  const broken: string[] = [];
  for (const scaffold of DISMISSAL_SCAFFOLDS) {
    if (!DISMISSAL_COMPONENTS.includes(scaffold.component)) {
      broken.push(
        `${scaffold.component}: listed as a scaffold but not in DISMISSAL_COMPONENTS.`
      );
      continue;
    }
    const full = path.resolve(MOBILE_APP, scaffold.source);
    if (!fs.existsSync(full)) {
      broken.push(
        `${scaffold.component}: expected source ${scaffold.source} is missing — ` +
          `update DISMISSAL_SCAFFOLDS in this script.`
      );
      continue;
    }
    const content = fs.readFileSync(full, "utf8");
    if (!providesDismissal(content, scaffold.component, scaffold.source)) {
      broken.push(
        `${scaffold.component}: ${scaffold.source} no longer renders the content it is ` +
          `given underneath a dismissal layer, so every screen built on it is ` +
          `unprotected. Restore it, or drop ${scaffold.component} from ` +
          `DISMISSAL_COMPONENTS and wrap those screens directly.`
      );
    }
  }
  return broken;
}

/** An exception that is stale or no longer needed must be removed. */
function findObsoleteExceptions(app: MobileApp): string[] {
  const problems: string[] = [];
  for (const exception of EXCEPTIONS) {
    if (!exception.reason.trim()) {
      problems.push(`${exception.file}: exception has no reason. Explain why it is safe.`);
      continue;
    }
    const module = app.moduleFor(exception.file);
    if (!module) {
      problems.push(
        `${exception.file}: not a file this check scans any more — remove the exception.`
      );
      continue;
    }
    // Scan it as if it were not excepted, to see what it would report.
    const unexcepted: ModuleInfo = { ...module, relFile: `${module.relFile}#unexcepted` };
    if (scanModule(app, unexcepted).length === 0) {
      problems.push(
        `${exception.file}: every text input is covered now (or the file has none) ` +
          `— remove the exception.`
      );
    }
  }
  return problems;
}

function main() {
  if (!fs.existsSync(ROUTES_DIR)) {
    console.error(
      `[lint-mobile-keyboard-dismiss] FAIL — mobile screens not found at ${ROUTES_DIR}`
    );
    process.exit(2);
  }

  const broken = findBrokenScaffolds();
  if (broken.length > 0) {
    console.error(`[lint-mobile-keyboard-dismiss] FAIL — scaffold check:\n`);
    for (const problem of broken) console.error(`  ${problem}`);
    process.exit(1);
  }

  const app = MobileApp.fromDisk();

  const obsolete = findObsoleteExceptions(app);
  if (obsolete.length > 0) {
    console.error(
      `[lint-mobile-keyboard-dismiss] FAIL — ${obsolete.length} stale exception(s):\n`
    );
    for (const problem of obsolete) console.error(`  ${problem}`);
    process.exit(1);
  }

  const scanned = app.scannableModules();
  const violations = app.scan();

  if (violations.length === 0) {
    console.log(
      `[lint-mobile-keyboard-dismiss] OK — ${scanned.length} file(s) scanned, ` +
        `every text input can close the keyboard` +
        (EXCEPTIONS.length > 0 ? ` (${EXCEPTIONS.length} documented exception(s)).` : ".")
    );
    process.exit(0);
  }

  console.error(
    `[lint-mobile-keyboard-dismiss] FAIL — ${violations.length} text input(s) trap the keyboard:\n`
  );
  for (const violation of violations) {
    console.error(
      `  ${violation.file}:${violation.line}:${violation.column}  [<${violation.component}>]`
    );
    console.error(`    Code:   ${violation.text}`);
    console.error(`    Path:   ${violation.path}`);
    console.error(`    Reason: ${violation.reason}`);
    console.error();
  }
  console.error(
    `A file that genuinely cannot trap a keyboard can be exempted by adding it to ` +
      `EXCEPTIONS in scripts/src/lint-mobile-keyboard-dismiss.ts with the reason why.`
  );
  process.exit(1);
}

const isDirectRun =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
