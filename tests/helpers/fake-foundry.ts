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

const GLOBALS = ["game", "canvas", "CONFIG", "foundry", "ui", "PIXI", "Hooks"] as const;
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

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Foundry's `Document#update` merge semantics, which the ownership ledger depends on.
 *
 * Two behaviours matter and both are load-bearing:
 *
 * - A dotted path writes into the nested object, creating intermediate levels.
 * - A nested PLAIN OBJECT is DEEP-MERGED, not replaced. That is the semantics the module
 *   relies on for `-=` deletions elsewhere, and it is exactly why writing a whole ledger
 *   object could never remove a key from it.
 */
export function applyUpdate(target: any, changes: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(changes)) {
    const segments = path.split(".");
    let node = target;

    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (typeof node[segment] !== "object" || node[segment] === null) node[segment] = {};
      node = node[segment];
    }

    const last = segments[segments.length - 1];
    if (last.startsWith("-=")) {
      delete node[last.slice(2)];
      continue;
    }
    node[last] = mergeValue(node[last], value);
  }
}

function mergeValue(current: unknown, next: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(next)) return next;

  const out: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (key.startsWith("-=")) {
      delete out[key.slice(2)];
      continue;
    }
    out[key] = mergeValue(out[key], value);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    ...options,
  };

  doc.update = async (changes: Record<string, unknown>, context?: unknown) => {
    doc.updates.push(changes);
    doc.lastContext = context;
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
    // A real tile always has a texture — see PLACEHOLDER_TEXTURE — and the manager
    // captures it to restore later.
    mesh: { texture: { id: "core-texture" }, alpha: 1, visible: true },
    renderFlags: { set: () => {} },
  };
  return doc;
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

    close() {
      this.rendered = false;
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
    },
  };

  const canvas: any = {
    ready: true,
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
    dimensions: { width: 3840, height: 1920, sceneX: 0, sceneY: 0 },
    app: { renderer: { resolution: 1, screen: { width: 1920, height: 1080 } }, ticker: null },
    stage: { worldTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, scale: { x: 1, y: 1 } },
    visibility: { testVisibility: () => true },
  };

  (globalThis as any).game = game;
  (globalThis as any).canvas = canvas;
  (globalThis as any).CONFIG = { Canvas: { layers: {} }, Tile: {}, fontDefinitions: {} };
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
      layers: { CanvasLayer: class CanvasLayer {} },
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
      hud: {},
      ux: {},
    },
    abstract: {},
    data: {},
  };

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
