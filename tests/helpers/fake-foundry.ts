/**
 * A Foundry thin enough to test the seams with.
 *
 * The 403 tests this repository shipped with covered pure functions and markup strings,
 * and every blocking defect the review found lived in the gap between them: an
 * ApplicationV2 action handler with the wrong signature, a layer that built no hit area,
 * a listener re-attached on every render, a document update whose merge semantics nobody
 * had modelled. None of those are visible from a pure function's return value.
 *
 * So this file is deliberately NOT a Foundry emulator. It provides exactly the shapes
 * the module actually touches, and each one is documented with the real behaviour it is
 * standing in for — because a fake that quietly differs from the thing it imitates is
 * how a suite gets to 403 green tests over code that has never run.
 */

const GLOBALS = ["game", "canvas", "CONFIG", "foundry", "ui", "PIXI", "Hooks", "CONST"] as const;
const saved = new Map<string, unknown>();

/** Every animation scheduled since the world was installed, newest last. */
export interface ScheduledAnimation {
  name: string;
  attributes: { attribute: string; to: number }[];
}
let animations: ScheduledAnimation[] = [];

export function scheduledAnimations(): ScheduledAnimation[] {
  return animations;
}

const canvasAnimation = {
  easeInOutCosine: () => 0,
  animate: async (attributes: any[], options: any = {}) => {
    animations.push({
      name: String(options.name ?? ""),
      attributes: attributes.map((a) => ({ attribute: a.attribute, to: a.to })),
    });
    for (const a of attributes) a.parent[a.attribute] = a.to;
  },
};

/** What `DialogV2.confirm` resolves to. Set per test; reset by `installWorld`. */
let dialogAnswer = true;

export function answerDialogs(answer: boolean): void {
  dialogAnswer = answer;
}

/** One thing the fake canvas did with a ping, in the order it happened. */
export interface RecordedPing {
  /** Sent to every client, drawn on this one, or this client's view pulled to it. */
  kind: "broadcast" | "local" | "pan";
  user: any;
  origin: { x: number; y: number };
  data: Record<string, any>;
}

/** Every ping the installed canvas has broadcast, drawn or panned to, oldest first. */
export function recordedPings(): RecordedPing[] {
  return (globalThis as any).canvas?.pingRecord ?? [];
}

/** Hold (or release) a modifier, as `game.keyboard.isModifierActive` will report it. */
export function holdModifier(modifier: "Shift" | "Alt" | "Control", held = true): void {
  const keys: Set<string> | undefined = (globalThis as any).game?.keyboard?.held;
  if (held) keys?.add(modifier);
  else keys?.delete(modifier);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * `foundry.data.operators`, just enough to be told apart and applied.
 *
 * v14 replaced the `-=key` / `==key` special keys with these values (foundry.mjs 14.367,
 * lines 1369-1510). The old keys still work, each with a compatibility warning, and are
 * removed in v16.
 */
export class DataFieldOperator {
  constructor(readonly value?: unknown) {}
  static get(value: unknown): unknown {
    return value instanceof DataFieldOperator ? value.value : value;
  }
}
export class ForcedDeletion extends DataFieldOperator {}
export class ForcedReplacement extends DataFieldOperator {
  static create(value: unknown): ForcedReplacement {
    return new ForcedReplacement(value);
  }
}

/**
 * v14's `Document#update`, for the parts the module's writes depend on.
 *
 * The fake this replaces modelled v13 — apply `-=key`, then merge `key` beside it, in order
 * — and so did the module's ownership ledger, which v14 corrupted on every write while this
 * suite stayed green. What v14 actually does, traced in `foundry.mjs` 14.367:
 *
 * - **Dotted keys are expanded at EVERY depth inside a flag** (`ObjectField` cleaning,
 *   `#reconstructOperators`, lines 10567-10578), not only in the update's own paths. A
 *   flag value keyed by UUIDs is stored nested.
 * - **The change is DIFFED against the stored value, then merged** (`_diffObject`, lines
 *   1892-1913; `ObjectField#_updateDiff`, 10599-10625). A `-=key` becomes a deletion of
 *   `key` — kept only if `key` exists — and a later plain `key` in the same object is
 *   diffed and OVERWRITES that deletion. A plain object that only lost keys diffs to
 *   nothing: its missing keys are never removed.
 * - **`ForcedDeletion` and `ForcedReplacement`** delete a key and replace a value whole.
 */
export function applyUpdate(target: any, changes: Record<string, unknown>): void {
  const change = expandPaths(changes);
  if (isPlainObject(change.flags)) change.flags = expandDeep(change.flags);
  const result = applyDiff(target, diffObject(target, change));
  for (const key of Object.keys(target)) if (!(key in result)) delete target[key];
  Object.assign(target, result);
}

/**
 * `DocumentOwnershipField` validation (foundry.mjs 14.367, ~12468), which runs on the
 * change BEFORE it is applied (`ObjectField#_updateDiff`, 10604-10610). Every value must be
 * a permission level, so a deletion — a `-=key`, or a `ForcedDeletion` value — is refused;
 * a `ForcedReplacement` is checked as the record it replaces with. Measured by running
 * 14.367's own update path. (Core also requires every key but `default` to be a 16-char
 * id; the tests name players "ali" and "ben", so that half is not modelled.)
 */
function ownershipAccepts(ownership: unknown): boolean {
  if (ownership === undefined) return true;
  const record = ownership instanceof ForcedReplacement ? ownership.value : ownership;
  if (!isPlainObject(record)) return false;
  return Object.entries(record).every(
    ([key, value]) =>
      !key.startsWith("-=") && typeof value === "number" && value >= -1 && value <= 3
  );
}

/** The update's own dotted paths, as nested objects. */
function expandPaths(changes: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [path, value] of Object.entries(changes)) {
    const segments = path.split(".");
    let node = out;
    for (const segment of segments.slice(0, -1)) {
      if (!isPlainObject(node[segment])) node[segment] = {};
      node = node[segment];
    }
    node[segments[segments.length - 1]] = value;
  }
  return out;
}

/** Every dotted key at every depth, as v14 does inside a flag. Operators are left alone. */
function expandDeep(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const [key, inner] of Object.entries(value)) {
    const expanded = isPlainObject(inner) ? expandDeep(inner) : inner;
    const segments = key.split(".");
    let node = out;
    for (const segment of segments.slice(0, -1)) {
      if (!isPlainObject(node[segment])) node[segment] = {};
      node = node[segment];
    }
    const last = segments[segments.length - 1];
    node[last] =
      isPlainObject(node[last]) && isPlainObject(expanded)
        ? { ...node[last], ...expanded }
        : expanded;
  }
  return out;
}

function diffObject(original: any, other: Record<string, unknown>): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  const source = isPlainObject(original) ? original : {};
  for (let [key, value] of Object.entries(other)) {
    if (key.startsWith("-=")) {
      key = key.slice(2);
      value = new ForcedDeletion();
    }
    if (value instanceof DataFieldOperator) {
      if (value instanceof ForcedReplacement || key in source) diff[key] = value;
      continue;
    }
    const [different, difference] = diffValue(source[key], value);
    if (different) diff[key] = difference;
  }
  return diff;
}

function diffValue(v0: unknown, v1: unknown): [boolean, unknown] {
  if (v1 === undefined || v1 === null) return [v0 !== v1, v1];
  if (isPlainObject(v0) && isPlainObject(v1)) {
    if (!Object.keys(v1).length) return [false, undefined];
    const d = diffObject(v0, v1);
    return [Object.keys(d).length > 0, d];
  }
  return [v0 !== v1, v1];
}

/** `mergeObject(source, diff, {applyOperators: true})`. */
function applyDiff(target: any, diff: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(diff)) {
    if (value instanceof ForcedDeletion) delete out[key];
    else if (value instanceof ForcedReplacement) out[key] = value.value;
    else if (isPlainObject(value)) out[key] = applyDiff(out[key], value);
    else out[key] = value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof DataFieldOperator)
  );
}

export interface FakeDocOptions {
  id?: string;
  uuid?: string;
  documentName?: string;
  [key: string]: unknown;
}

/** A document that records its updates and applies them with Foundry's own semantics. */
export function fakeDoc(options: FakeDocOptions = {}): any {
  const doc: any = {
    id: "d1",
    uuid: "Doc.d1",
    documentName: "JournalEntry",
    flags: {},
    ownership: {},
    updates: [] as Record<string, unknown>[],
    /** Updates core would have refused, and so never applied. */
    rejected: [] as Record<string, unknown>[],
    ...options,
  };

  doc.update = async (changes: Record<string, unknown>, context?: unknown) => {
    doc.updates.push(changes);
    doc.lastContext = context;
    // What core does with an update that fails validation: an error toast, the WHOLE
    // update dropped, and a promise that resolves anyway. Nothing throws to the caller.
    if (!ownershipAccepts(expandPaths(changes).ownership)) {
      doc.rejected.push(changes);
      return undefined;
    }
    applyUpdate(doc, changes);
    return doc;
  };
  doc.delete = async () => {
    doc.deleted = true;
    return doc;
  };
  doc.getFlag = (scope: string, key: string) => doc.flags?.[scope]?.[key];
  doc.testUserPermission = doc.testUserPermission ?? (() => true);
  return doc;
}

/** A TileDocument with a placeable attached, which is what the canvas layers walk. */
export function fakeTile(options: FakeDocOptions = {}): any {
  const doc = fakeDoc({
    documentName: "Tile",
    x: 0,
    y: 0,
    width: 200,
    height: 280,
    rotation: 0,
    hidden: false,
    alpha: 1,
    sort: 0,
    elevation: 0,
    texture: { src: "icons/svg/book.svg" },
    ...options,
  });

  doc.object = {
    id: doc.id,
    document: doc,
    isVisible: true,
    controlled: false,
    isPreview: false,
    hasPreview: false,
    // A real tile always has a texture — see PLACEHOLDER_TEXTURE — and the manager
    // captures it to restore later.
    mesh: { texture: { id: "core-texture" }, alpha: 1, visible: true },
    renderFlags: { set: () => {} },
    // Core's own geometry, as measured on 14.365: the document's point is the CENTRE, and
    // `bounds` starts half a box before it. The 14.366 type definitions still document the
    // point as the top-left corner; the live canvas is the authority, and this fake models
    // the live canvas. `checkTileGeometry` compares the two at every draw.
    get bounds() {
      return tileBounds(doc);
    },
    get center() {
      return { x: doc.x, y: doc.y };
    },
  };
  return doc;
}

/** The axis-aligned bounds core reports for a tile drawn about its centre. */
function tileBounds(doc: any): { x: number; y: number; width: number; height: number } {
  const rot = ((doc.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rot));
  const sin = Math.abs(Math.sin(rot));
  const width = doc.width * cos + doc.height * sin;
  const height = doc.width * sin + doc.height * cos;
  return { x: doc.x - width / 2, y: doc.y - height / 2, width, height };
}

/**
 * The Tile placeable, thin enough to chain `PinnedTile` onto.
 *
 * Models the parts of core's drag that the module reaches into, each with the real
 * behaviour it stands in for:
 *
 * - `clone()` builds `new this.constructor(copy)`, keeps the document id and flags, and
 *   points `_original` back — so a clone of a PinnedTile IS a PinnedTile and reads as a
 *   pin. `isPreview` is `!!_original`; `hasPreview` is `!!_preview`.
 * - `_draw()` takes the texture from `_original.texture` when there is one: a preview
 *   draws the placeholder the original was created with, never what a manager bound to
 *   the original's mesh.
 * - `_refreshState()` and `_refreshMesh()` write `document.alpha` back onto the mesh,
 *   which is the reset any override has to survive.
 * - `_onDragLeftStart` clones every controlled object into `layer.preview`;
 *   `_onDragLeftMove` moves the clones' documents synchronously; drop and cancel clear
 *   the preview and destroy the clones. Drop records what would be committed.
 */
export function fakeTileClass(): any {
  const layer = { preview: { children: [] as any[] }, controlled: [] as any[] };

  return class Tile {
    static layer = layer;
    document: any;
    mesh: any = null;
    texture: any;
    _original: any = null;
    _preview: any = null;
    _controlled = false;
    destroyed = false;
    drawn = 0;
    layer = layer;
    /** What `_onDragLeftDrop` would have written. */
    committed: any[] = [];

    constructor(document: any) {
      this.document = document;
      this.texture = { id: `placeholder:${document?.texture?.src ?? ""}` };
    }

    get id() {
      return this.document.id;
    }
    get isPreview() {
      return !!this._original;
    }
    get hasPreview() {
      return !!this._preview;
    }
    get controlled() {
      return this._controlled;
    }
    get isVisible() {
      return true;
    }
    get bounds() {
      return tileBounds(this.document);
    }
    get center() {
      return { x: this.document.x, y: this.document.y };
    }

    clone() {
      const copy = { ...this.document, flags: this.document.flags, parent: this.document.parent };
      const clone = new (this.constructor as any)(copy);
      clone._original = this;
      this._preview = clone;
      return clone;
    }

    async draw() {
      await this._draw();
      return this;
    }
    async _draw() {
      this.drawn++;
      this.mesh = {
        texture: this._original?.texture ?? this.texture,
        alpha: this.document.alpha ?? 1,
        visible: true,
      };
    }
    _refreshState() {
      if (this.mesh) this.mesh.alpha = this.document.alpha ?? 1;
    }
    _refreshMesh() {
      if (this.mesh) this.mesh.alpha = this.document.alpha ?? 1;
    }
    _refreshVisibility() {}
    _canControl() {
      return true;
    }
    _canHover() {
      return true;
    }
    _onClickLeft() {}
    _onClickLeft2() {}
    _onControl(_options?: any) {}
    _onRelease(_options?: any) {}
    _onUpdate() {}

    control(options?: any) {
      this._controlled = true;
      if (!layer.controlled.includes(this)) layer.controlled.push(this);
      this._onControl(options);
      return true;
    }
    release(options?: any) {
      this._controlled = false;
      layer.controlled = layer.controlled.filter((o) => o !== this);
      this._onRelease(options);
      return true;
    }

    _onDragLeftStart(event: any) {
      const clones = layer.controlled.map((o) => o.clone());
      event.interactionData.clones = clones;
      layer.preview.children.push(...clones);
      for (const clone of clones) void clone.draw();
    }
    _onDragLeftMove(event: any) {
      const { clones, origin, destination } = event.interactionData;
      for (const clone of clones ?? []) {
        clone.document.x = clone._original.document.x + (destination.x - origin.x);
        clone.document.y = clone._original.document.y + (destination.y - origin.y);
      }
    }
    _onDragLeftDrop(event: any) {
      for (const clone of event.interactionData.clones ?? []) {
        this.committed.push({ _id: clone._original.id, x: clone.document.x, y: clone.document.y });
      }
      this.#clearPreview(event);
    }
    _onDragLeftCancel(event: any) {
      this.#clearPreview(event);
    }
    #clearPreview(event: any) {
      for (const clone of event.interactionData.clones ?? []) {
        clone._original._preview = null;
        clone._destroy();
      }
      layer.preview.children = [];
    }

    destroy() {
      this._destroy();
    }
    _destroy() {
      this.destroyed = true;
    }
  };
}

// ---------------------------------------------------------------------------
// PIXI
// ---------------------------------------------------------------------------

/** Just enough PIXI for the hit layer: a container that records its handlers. */
export function fakePixi(): any {
  class Container {
    children: any[] = [];
    handlers = new Map<string, ((event: any) => void)[]>();
    eventMode = "auto";
    cursor = "";
    hitArea: any = null;
    interactiveChildren = true;
    destroyed = false;

    on(type: string, handler: (event: any) => void) {
      const list = this.handlers.get(type) ?? [];
      list.push(handler);
      this.handlers.set(type, list);
      return this;
    }
    addChild(child: any) {
      this.children.push(child);
      return child;
    }
    removeChildren() {
      const out = this.children;
      this.children = [];
      return out;
    }
    destroy() {
      this.destroyed = true;
    }
    /** Fire every handler registered for a type, as the pointer system would. */
    emit(type: string, event: any = {}) {
      for (const handler of this.handlers.get(type) ?? []) handler(event);
    }
  }

  class Polygon {
    points: number[];
    constructor(points: number[]) {
      this.points = points;
    }
  }

  return {
    Container,
    Polygon,
    UPDATE_PRIORITY: { LOW: -1 },
    MIPMAP_MODES: { ON: 1 },
    SCALE_MODES: { LINEAR: 1 },
    Texture: { from: () => ({ destroy: () => {} }), EMPTY: { id: "PIXI.Texture.EMPTY" } },
  };
}

// ---------------------------------------------------------------------------
// ApplicationV2
// ---------------------------------------------------------------------------

/**
 * The two ApplicationV2 behaviours the module gets wrong when nobody models them.
 *
 * 1. **An action handler is invoked as `handler.call(app, event, target)`.** `this` is
 *    the application and the FIRST argument is the PointerEvent. A handler declared as
 *    `(app) => ...` therefore receives the event and silently operates on the wrong
 *    object — which is how "Reveal all" came to be a no-op rather than an error.
 * 2. **`_replaceHTML(result, content)` hands back the SAME `content` element on every
 *    render.** Only `result` is new. Anything attached to `content` per render
 *    accumulates, and since these handlers trigger renders, the growth compounds.
 */
export function fakeApplicationV2(): any {
  return class ApplicationV2 {
    static DEFAULT_OPTIONS: any = {};
    rendered = false;
    renderCount = 0;
    /** The persistent window-content element, exactly as ApplicationV2 keeps it. */
    content: HTMLElement =
      typeof document === "undefined" ? (null as any) : document.createElement("div");

    async render(_force?: unknown) {
      this.renderCount++;
      const result = await (this as any)._renderHTML();
      (this as any)._replaceHTML(result, this.content);
      this.rendered = true;
      return this;
    }

    // `_onClose` runs once the application HAS closed, and the close does not await it
    // (TYPES `application.d.mts:1019-1028`): a returned promise is dropped on the floor.
    close() {
      this.rendered = false;
      (this as any)._onClose?.({});
      return Promise.resolve(this);
    }

    /** Dispatch an action the way ApplicationV2's own delegated listener does. */
    dispatch(action: string, target?: HTMLElement, event: any = {}) {
      const handler = (this.constructor as any).DEFAULT_OPTIONS?.actions?.[action];
      if (!handler) throw new Error(`no action handler for ${action}`);
      return handler.call(this, event, target ?? document.createElement("button"));
    }
  };
}

/**
 * `BasePlaceableHUD`, with the one property that matters modelled correctly.
 *
 * **`object` is a GETTER with no setter**, and `bind()` is what sets it. Assigning to it
 * throws `TypeError: Cannot set property object`, and because `PlaceableObject#control()`
 * calls `_onControl` BEFORE setting the render flag that draws the selection frame, that
 * throw left a pin selected with no frame and no resize handles.
 *
 * The previous fake let `object` be assigned, so every HUD test passed over code that
 * threw the moment a GM clicked a pin in a real world.
 */
export function fakeBasePlaceableHUD(): any {
  const ApplicationV2 = fakeApplicationV2();
  return class BasePlaceableHUD extends ApplicationV2 {
    #object: any = null;

    get object() {
      return this.#object;
    }

    async bind(object: any) {
      this.#object = object;
      return this.render(true);
    }

    clear() {
      this.#object = null;
      this.rendered = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface FakeWorld {
  isGM?: boolean;
  userId?: string;
  /** Non-GM users, in the order `playerIds()` should report them. */
  players?: { id: string; name?: string }[];
  tiles?: any[];
  settings?: Record<string, unknown>;
}

export interface InstalledWorld {
  game: any;
  canvas: any;
  hooks: { name: string; args: unknown[] }[];
  notifications: { type: string; message: string }[];
}

/**
 * Install the globals the module reaches for, and return the handles a test needs.
 *
 * `src/fvtt.ts` reads every global through `typeof x === "undefined"` guards, so an
 * absent global is a supported state — which is why the module can be imported under
 * Node at all, and why these can be installed per test rather than in a setup file.
 */
export function installWorld(world: FakeWorld = {}): InstalledWorld {
  for (const name of GLOBALS) {
    if (!saved.has(name)) saved.set(name, (globalThis as any)[name]);
  }

  const players = world.players ?? [
    { id: "ali", name: "Ali" },
    { id: "ben", name: "Ben" },
  ];
  const userId = world.userId ?? (world.isGM ? "gm" : players[0]?.id) ?? "gm";
  const users = [
    { id: "gm", name: "GM", isGM: true, active: true, color: "#ffffff", avatar: null },
    ...players.map((p) => ({
      isGM: false,
      active: true,
      color: "#7a7971",
      avatar: null,
      name: p.id,
      ...p,
    })),
  ];

  const tiles = world.tiles ?? [];
  const hooks: { name: string; args: unknown[] }[] = [];
  const notifications: { type: string; message: string }[] = [];
  const settings = { ...(world.settings ?? {}) };
  dialogAnswer = true;
  animations = [];

  const scene: any = {
    name: "Test Scene",
    grid: { size: 100 },
    foregroundElevation: 20,
    tiles: {
      contents: tiles,
      get: (id: string) => tiles.find((t: any) => t.id === id) ?? null,
    },
    notes: { contents: [] },
    createEmbeddedDocuments: async () => [],
    updateEmbeddedDocuments: async () => [],
    deleteEmbeddedDocuments: async () => [],
  };

  const game: any = {
    user: users.find((u) => u.id === userId) ?? users[0],
    users: {
      contents: users,
      get: (id: string) => users.find((u) => u.id === id) ?? null,
      activeGM: users[0],
    },
    journal: { contents: [], get: () => null },
    // `AudioHelper#locked` (TYPES, audio/helper.d.mts:70-79): `true` until the browser has
    // seen the gesture that unlocks audio. Unlocked here; a test sets it to lock.
    audio: { locked: false },
    scenes: { contents: [scene], current: scene },
    modules: { get: () => ({}) },
    i18n: { localize: (key: string) => key, format: (key: string) => key },
    settings: {
      get: (_scope: string, key: string) => settings[key],
      set: async (_scope: string, key: string, value: unknown) => {
        settings[key] = value;
      },
      register: () => {},
    },
    keybindings: {
      registered: [] as { key: string; options: any }[],
      register: (_scope: string, key: string, options: any) => {
        game.keybindings.registered.push({ key, options });
      },
      /** What `set` stored, by action: a GM's rebinding in Configure Controls. */
      rebound: new Map<string, { key: string; modifiers?: string[] }[]>(),
      // `ClientKeybindings#get(namespace, action)` (TYPES client-keybindings.d.mts:85): the
      // bindings as configured NOW — the registered `editable` until `set` replaces them.
      // An action nobody registered THROWS (RECALLED, "This is not a registered keybind
      // action"), so a caller that reads one must guard.
      get(_scope: string, action: string) {
        const rebound = game.keybindings.rebound.get(action);
        if (rebound) return rebound;
        const found = game.keybindings.registered.find((r: any) => r.key === action);
        if (!found) throw new Error("This is not a registered keybind action");
        return found.options.editable ?? [];
      },
      // `ClientKeybindings#set` (TYPES client-keybindings.d.mts:105).
      async set(_scope: string, action: string, bindings: { key: string; modifiers?: string[] }[]) {
        game.keybindings.rebound.set(action, bindings);
      },
    },
    // `KeyboardManager#isModifierActive`, which core's `Canvas#ping` reads to decide a
    // pull (Shift) or an alert (Alt) the caller did not state. `holdModifier` presses.
    keyboard: {
      held: new Set<string>(),
      isModifierActive(modifier: string) {
        return this.held.has(modifier);
      },
    },
  };

  const canvas: any = {
    ready: true,
    /** What `ping`, `controls.handlePing` and `animatePan` did; read by `recordedPings`. */
    pingRecord: [] as RecordedPing[],
    // `Canvas#ping`, as core builds it (RECALLED from v11–v13; consistent with the 14.366
    // doc, `board.d.mts:597-605`). Refused outside the scene's rect. A base of
    // `{scene, pull: <Shift held>, style: Shift ? PULL : Alt ? ALERT : PULSE, zoom}` with
    // the caller's options MERGED OVER it — so a held Shift pulls every view unless the
    // caller states `pull` — broadcast to every other client, then drawn on this one.
    ping(origin: { x: number; y: number }, options: Record<string, unknown> = {}) {
      if (!canvas.dimensions.rect.contains(origin.x, origin.y)) return Promise.resolve(false);
      const types = (globalThis as any).CONFIG?.Canvas?.pings?.types ?? {};
      const shift = game.keyboard.isModifierActive("Shift");
      const alt = game.keyboard.isModifierActive("Alt");
      const style = shift ? types.PULL : alt ? types.ALERT : types.PULSE;
      const zoom = canvas.stage.scale.x;
      const data = { scene: canvas.scene?.id, pull: shift, style, zoom, ...options };
      canvas.pingRecord.push({ kind: "broadcast", user: game.user, origin, data });
      return canvas.controls.handlePing(game.user, origin, data);
    },
    // `ControlsLayer#handlePing` (TYPES `controls.d.mts:197-210`, body RECALLED): draws
    // nothing and resolves false unless `data.scene` is the viewed scene's id — "an
    // object containing a valid scene property must be passed" — and, for a pull from a
    // GM or from this client, pans this client's view to the spot first. A missing id is
    // refused even here, where the test scene may have none: a real scene always has one,
    // and letting `{}` draw on an id-less scene passed the very call this exists to catch.
    controls: {
      handlePing(user: any, origin: { x: number; y: number }, data: any = {}) {
        if (!canvas.ready || !origin || !data?.scene || data.scene !== canvas.scene?.id) {
          return Promise.resolve(false);
        }
        if (data.pull && (user?.isGM || user?.id === game.user?.id)) {
          void canvas.animatePan({ x: origin.x, y: origin.y, duration: 700 });
        }
        canvas.pingRecord.push({ kind: "local", user, origin, data });
        return Promise.resolve(true);
      },
    },
    // `Canvas#animatePan`: records the view it would move to, and arrives at once.
    animatePan(view: { x: number; y: number }) {
      canvas.pingRecord.push({ kind: "pan", user: game.user, origin: view, data: view });
      return Promise.resolve(true);
    },
    scene,
    grid: { size: 100 },
    tiles: {
      placeables: tiles.map((t: any) => t.object).filter(Boolean),
      get: (id: string) => tiles.find((t: any) => t.id === id)?.object ?? null,
      zIndex: 10,
    },
    tokens: { placeables: [], zIndex: 30 },
    notes: { zIndex: 40 },
    // The padded scene rect, which is the space TileDocument x/y live in — and a
    // different space from the renderer's screen.
    dimensions: {
      width: 3840,
      height: 1920,
      sceneX: 0,
      sceneY: 0,
      // `PIXI.Rectangle#contains` over the whole padded rect, which `Canvas#ping` checks.
      rect: {
        x: 0,
        y: 0,
        width: 3840,
        height: 1920,
        contains(x: number, y: number) {
          return x >= this.x && x < this.x + this.width && y >= this.y && y < this.y + this.height;
        },
      },
    },
    app: { renderer: { resolution: 1, screen: { width: 1920, height: 1080 } }, ticker: null },
    stage: { worldTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, scale: { x: 1, y: 1 } },
    visibility: { testVisibility: () => true },
    // `EnvironmentCanvasGroup#darknessLevel` (TYPES, groups/environment.d.mts:54-58): a
    // number once the environment has initialised, `undefined` before. Core's own
    // `canvas.darknessLevel` getter THROWS before initialisation, which is why the fake
    // has no such getter — nothing may read it.
    environment: { darknessLevel: 0 },
  };

  (globalThis as any).game = game;
  (globalThis as any).canvas = canvas;
  (globalThis as any).CONFIG = {
    // `CONFIG.Canvas.pings.types`, core's defaults (TYPES `config.d.mts:2665-2690`).
    Canvas: {
      layers: {},
      pings: { types: { PULSE: "pulse", PULL: "chevron", ALERT: "alert", ARROW: "arrow" } },
    },
    Tile: {},
    fontDefinitions: {},
  };
  (globalThis as any).PIXI = fakePixi();
  (globalThis as any).ui = {
    notifications: {
      info: (message: string) => notifications.push({ type: "info", message }),
      warn: (message: string) => notifications.push({ type: "warn", message }),
      error: (message: string) => notifications.push({ type: "error", message }),
    },
  };
  (globalThis as any).Hooks = {
    on: () => {},
    once: () => {},
    call: (name: string, ...args: unknown[]) => hooks.push({ name, args }),
    callAll: (name: string, ...args: unknown[]) => hooks.push({ name, args }),
  };
  (globalThis as any).foundry = {
    canvas: {
      // v14's own default, which is what left every player's hit area dead: a layer that
      // never turns this on has all of its children skipped by the hit test.
      layers: {
        CanvasLayer: class CanvasLayer {
          interactiveChildren = false;
        },
      },
      // Records what was scheduled and resolves to the end state. The RECORD is what
      // matters for assertions: a real animation runs over its duration, so "did this
      // touch the mesh at all" cannot be read off the final value.
      animation: { CanvasAnimation: canvasAnimation },
    },
    utils: {
      fromUuidSync: () => null,
      fromUuid: async () => null,
      randomID: () => "id",
    },
    applications: {
      api: {
        ApplicationV2: fakeApplicationV2(),
        // Every confirmation in the module goes through this; tests set the answer.
        DialogV2: { confirm: async () => dialogAnswer },
      },
      hud: { BasePlaceableHUD: fakeBasePlaceableHUD() },
      ux: {},
      settings: { menus: { FontConfig: fakeFontConfig() } },
      apps: { FilePicker: fakeFilePicker() },
    },
    abstract: {},
    data: { operators: { DataFieldOperator, ForcedDeletion, ForcedReplacement } },
    audio: { AudioHelper: fakeAudioHelper() },
    // `foundry.CONST`, the same object core also exposes as the global `CONST` (TYPES,
    // common/constants.d.mts:787-795 and :1825-1840).
    CONST: {
      AUDIO_CHANNELS: {
        music: "AUDIO.CHANNELS.MUSIC.label",
        environment: "AUDIO.CHANNELS.ENVIRONMENT.label",
        interface: "AUDIO.CHANNELS.INTERFACE.label",
      },
      KEYBINDING_PRECEDENCE: { PRIORITY: 0, NORMAL: 1, DEFERRED: 2 },
    },
  };
  (globalThis as any).CONST = (globalThis as any).foundry.CONST;

  return { game, canvas, hooks, notifications };
}

/** An application's persistent content element, typed so `querySelector<T>` works. */
export function contentOf(app: { content: unknown }): HTMLElement {
  return app.content as HTMLElement;
}

export function uninstallWorld(): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete (globalThis as any)[name];
    else (globalThis as any)[name] = value;
  }
  saved.clear();
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/** What `FontConfig.getAvailableFonts()` answers. Set per test; reset by `installWorld`. */
let availableFonts: string[] = [];

/** The families Font Config reports as loaded, for the next `getAvailableFonts()`. */
export function offerFonts(names: string[]): void {
  availableFonts = [...names];
}

/**
 * `foundry.applications.settings.menus.FontConfig`, for the two statics the module reads.
 *
 * TYPES (`settings/menus/font-config.d.mts`): `SETTING` is the literal `"fonts"`, the core
 * setting holding the faces a GM added — which `CONFIG.fontDefinitions` does NOT contain;
 * tests put those under `world.settings.fonts`. `getAvailableFonts()` lists only families
 * that LOADED with `editor: true`, so it answers nothing unless a test says so.
 */
function fakeFontConfig(): any {
  availableFonts = [];
  return class FontConfig {
    static SETTING = "fonts";
    static getAvailableFonts(): string[] {
      return [...availableFonts];
    }
  };
}

// ---------------------------------------------------------------------------
// Audio and the file browser
// ---------------------------------------------------------------------------

/** One `AudioHelper.play` call, as it was made. */
export interface PlayedSound {
  data: Record<string, unknown>;
  socket: unknown;
}
let played: PlayedSound[] = [];

/** Every sound played since the world was installed, oldest first. */
export function playedSounds(): PlayedSound[] {
  return played;
}

/**
 * `foundry.audio.AudioHelper`, for its static `play(data, socketOptions)` (TYPES,
 * audio/helper.d.mts:173-187). Core resolves a Sound, or nothing when `autoplay` is false;
 * this records the call and resolves. It does NOT refuse a remote `src` — core would fetch
 * it — so the module's own path rule is the only thing a test can see stopping one.
 */
function fakeAudioHelper(): any {
  played = [];
  return class AudioHelper {
    static async play(data: Record<string, unknown>, socket?: unknown) {
      played.push({ data: { ...data }, socket });
      return undefined;
    }
  };
}

/** One file browser the module opened: its options, and whether it was rendered. */
export interface OpenedPicker {
  options: { type?: string; current?: string; callback?: (path: string) => void };
  rendered: unknown[];
}
let pickers: OpenedPicker[] = [];

/** Every file browser opened since the world was installed; fire `options.callback` to pick. */
export function filePickers(): OpenedPicker[] {
  return pickers;
}

/**
 * `foundry.applications.apps.FilePicker`, reached as core configures it: through the
 * static `implementation` getter (TYPES, apps/file-picker.d.mts:179-181). Construction
 * records the options; the picker does nothing until `render` is called, as in core.
 */
function fakeFilePicker(): any {
  pickers = [];
  return class FilePicker {
    static get implementation() {
      return FilePicker;
    }
    record: OpenedPicker;
    constructor(options: OpenedPicker["options"] = {}) {
      this.record = { options, rendered: [] };
      pickers.push(this.record);
    }
    async render(options?: unknown) {
      this.record.rendered.push(options);
      return this;
    }
  };
}
