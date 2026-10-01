/**
 * documents-pinner — Spike 2 probe: compendium, Actor and Item sources
 *
 * Settles what the v14 type definitions cannot, before the sources chapter builds on it:
 *
 *   A  game.packs, pack ownership by role, the precomputed index, getIndex with page fields
 *   B  what fromUuidSync returns for a pack entry and a pack page (keys, throw, the cache flip)
 *   C  whether a player can load a document from a pack they cannot read (and one they can)
 *   D  the Actor/Item data the player's client holds; LIMITED actors in the player's sidebar
 *   E  the HTMLField paths discovered for this world's actor and item types (the REFERENCE
 *      traversal the module implements in src/sources/fields.ts)
 *   F  Actor img versus the prototype token texture versus the default icons
 *   G  the world's Actor/Item sheet classes and the view permission each needs
 *   +  interactive helpers: drag payloads, context-menu/header hook names, a LIMITED sheet,
 *      updateActor/updateItem payloads, and two opt-in WRITES (import, Journal.show)
 *
 * HOW TO RUN — in a TEST world, never a campaign world.
 *   1. GM, Chromium: open the world, F12, paste this WHOLE file, Enter. Copy the report.
 *   2. Player, second browser profile: same. The player-only sections run by themselves.
 *   3. Run the interactive helpers printed at the end of the report (__dpProbe2.*).
 *
 * WRITES: none by default. Section B loads ONE compendium document into this client's pack
 * cache (memory, not the world). Two helpers write and refuse unless called with
 * { iUnderstand: true }: importOne (creates and then deletes a world document and folder)
 * and showPack (opens a window on a player's screen). The drop recorder RETURNS FALSE while
 * armed so that no Note or Token is created by your test drops.
 *
 * Plain JS, no imports. Nothing here is the module's code; it only asks Foundry.
 */
(async () => {
  const R = [];
  const add = (verdict) => (id, q, a, note) => R.push({ id, q, verdict, answer: a, note });
  const ok = add("OK");
  const no = add("PROBLEM");
  const info = add("info");
  const safe = (fn, fallback = "n/a") => {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      return `threw: ${e?.message ?? e}`;
    }
  };
  const attempt = async (fn) => {
    try {
      return { value: await fn() };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  };
  const json = (v) => {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  const Doc = foundry.abstract.Document;
  const shapeOf = (v) =>
    v === null || v === undefined
      ? String(v)
      : v instanceof Doc
        ? `Document ${v.documentName} (${v.constructor.name})`
        : `plain object {${Object.keys(v).sort().join(", ")}}`;
  const fus = globalThis.fromUuidSync ?? foundry.utils.fromUuidSync;
  const fu = globalThis.fromUuid ?? foundry.utils.fromUuid;
  const isGM = game.user.isGM;
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  const levelName = (n) => Object.entries(L).find(([, v]) => v === n)?.[0] ?? String(n);
  const players = game.users.contents.filter((u) => !u.isGM);
  const TYPES = ["JournalEntry", "Actor", "Item"];
  const packsOf = (type) => game.packs.filter((p) => p.documentName === type);

  // ── 0. Environment ─────────────────────────────────────────────────────────
  info("0", "Who and where", [
    `core ${game.release?.version ?? game.version}`,
    `system ${game.system.id} ${game.system.version}`,
    `user ${game.user.name} isGM:${isGM} role:${game.user.role}`,
    `global fromUuidSync===foundry.utils.fromUuidSync: ${globalThis.fromUuidSync === foundry.utils?.fromUuidSync}`,
    `CACHE_LIFETIME_SECONDS: ${safe(() => foundry.documents.collections.CompendiumCollection.CACHE_LIFETIME_SECONDS)}`,
  ].join(" | "));

  // ── A. Packs, ownership by role, the index ─────────────────────────────────
  for (const type of TYPES) {
    const packs = packsOf(type);
    info(`A1.${type}`, `${type} packs on this client`, packs.length
      ? packs.map((p) => [
          `${p.collection} "${p.title}"`,
          `documentName:${p.documentName} metadata.type:${p.metadata?.type}`,
          `visible:${p.visible} locked:${p.locked}`,
          `ownership:${JSON.stringify(safe(() => p.ownership))}`,
          `myLevel:${levelName(safe(() => p.getUserLevel(game.user)))}`,
          `index.size:${p.index?.size} indexed:${p.indexed}`,
        ].join(" ")).join("\n         ")
      : "(none)");
  }

  if (isGM) {
    // The module decides "players can read this pack" from the GM's client, per player, by role.
    const rows = [];
    for (const p of TYPES.flatMap(packsOf)) {
      const per = players.map((u) => {
        const lvl = safe(() => p.getUserLevel(u));
        const obs = safe(() => p.testUserPermission(u, "OBSERVER"));
        return `${u.name}(role ${u.role}): ${levelName(lvl)} observer:${obs}`;
      });
      rows.push(`${p.collection}: ${per.join("; ") || "(no players)"}`);
    }
    info("A2", "getUserLevel / testUserPermission for EACH player, asked from the GM client",
      rows.join("\n         ") || "(no packs)",
      "Compare with each player's own A1 'myLevel' and 'visible'. Equal => the GM client can decide alone.");
  }

  // Index entry keys, before anything is loaded. Expect JournalEntry: _id,folder,name,sort,uuid.
  const firstPack = packsOf("JournalEntry").find((p) => p.index?.size);
  if (firstPack) {
    const entry = firstPack.index.contents[0];
    info("A3", "Keys of a JournalEntry pack index entry (precomputed, no getIndex called)",
      `${firstPack.collection}: ${shapeOf(entry)}`);
    for (const t of ["Actor", "Item"]) {
      const p = packsOf(t).find((x) => x.index?.size);
      if (p) info(`A3.${t}`, `Keys of an ${t} pack index entry`, `${p.collection}: ${shapeOf(p.index.contents[0])}`);
    }
  } else {
    no("A3", "A JournalEntry pack with a non-empty index", "none found",
      "Install any module or system with a journal compendium, or create a world compendium with two journals (one with 2+ pages, one a PDF page) and re-run.");
  }

  // ── B. fromUuidSync on pack documents — the seam ──────────────────────────
  if (firstPack && fus) {
    // Pick an entry this client has NOT cached yet (Collection#has does not touch the cache timer).
    const fresh = firstPack.index.contents.find((e) => !firstPack.has?.(e._id)) ?? firstPack.index.contents[0];
    const entryUuid = fresh.uuid ?? firstPack.getUuid?.(fresh._id);
    const before = attempt(() => fus(entryUuid));
    const b1 = await before;
    info("B1", "fromUuidSync(pack ENTRY uuid), parent NOT cached", `${entryUuid} -> ${b1.error ? `threw: ${b1.error}` : shapeOf(b1.value)}`,
      "Expected (types): the index entry, a plain object.");

    const fakePage = `${entryUuid}.JournalEntryPage.dpProbeNoSuchPg`;
    const b2 = await attempt(() => fus(fakePage));
    const b2s = await attempt(() => fus(fakePage, { strict: false }));
    info("B2", "fromUuidSync(pack PAGE uuid), parent NOT cached", `strict(default): ${b2.error ? `THREW "${b2.error}"` : shapeOf(b2.value)} | strict:false: ${b2s.error ? `threw ${b2s.error}` : shapeOf(b2s.value)}`,
      "Expected (types): throws by default; the module's wrapper turns a throw into null.");

    // Load it (client cache only — no world write), then ask again.
    const loaded = await attempt(() => fu(entryUuid));
    const doc = loaded.value;
    info("B3", "fromUuid(pack entry) as this user", loaded.error ? `threw: ${loaded.error}` : shapeOf(doc));
    if (doc) {
      const b4 = await attempt(() => fus(entryUuid));
      info("B4", "fromUuidSync(pack ENTRY) AFTER it was loaded", b4.error ? `threw: ${b4.error}` : shapeOf(b4.value),
        "If this is a Document, the sync answer FLIPS with the pack cache (CACHE_LIFETIME_SECONDS).");
      const page = doc.pages?.contents?.[0];
      if (page) {
        const b5 = await attempt(() => fus(page.uuid));
        info("B5", "fromUuidSync(real pack PAGE) AFTER the parent was loaded", `${page.uuid} -> ${b5.error ? `threw: ${b5.error}` : shapeOf(b5.value)}`);
        const p6 = await attempt(() => fu(page.uuid));
        info("B6", "fromUuid(pack PAGE uuid)", p6.error ? `threw: ${p6.error}` : `${shapeOf(p6.value)} type:${p6.value?.type}`);
      }
      info("B7", "A loaded pack document's own answers", [
        `pack:${doc.pack} inCompendium:${safe(() => doc.inCompendium)} compendium:${safe(() => doc.compendium?.collection)}`,
        `isOwner:${doc.isOwner} permission:${levelName(safe(() => doc.permission))}`,
        `testUserPermission(me,OBSERVER):${safe(() => doc.testUserPermission(game.user, "OBSERVER"))}`,
        `sheet:${safe(() => doc.sheet?.constructor?.name)}`,
      ].join(" | "));
    }

    if (isGM) {
      // Do page stubs come with the index if asked for? Client index only, no world write.
      const withPages = await attempt(() => firstPack.getIndex({ fields: ["pages._id", "pages.name", "pages.type"] }));
      const stub = firstPack.index.get(fresh._id);
      info("B8", "getIndex({fields: ['pages._id','pages.name','pages.type']}) -> entry.pages",
        withPages.error ? `threw: ${withPages.error}` : json(stub?.pages?.slice?.(0, 3) ?? stub?.pages ?? "(no pages key)"),
        "If page stubs arrive, the module can name and type a pack page synchronously.");
    }
  }

  // ── C. Player: loading from packs by level ─────────────────────────────────
  if (!isGM) {
    const toasts = [];
    const n = ui.notifications;
    const orig = { error: n.error, warn: n.warn };
    n.error = function (m, ...a) { toasts.push(`error: ${m}`); return orig.error.call(this, m, ...a); };
    n.warn = function (m, ...a) { toasts.push(`warn: ${m}`); return orig.warn.call(this, m, ...a); };
    const rows = [];
    try {
      for (const p of TYPES.flatMap(packsOf)) {
        const e = p.index?.contents?.[0];
        if (!e) { rows.push(`${p.collection}: level ${levelName(safe(() => p.getUserLevel(game.user)))} visible:${p.visible} — empty index on this client`); continue; }
        const before = toasts.length;
        const r = await attempt(() => fu(e.uuid ?? p.getUuid(e._id)));
        rows.push(`${p.collection}: level ${levelName(safe(() => p.getUserLevel(game.user)))} visible:${p.visible} -> ` +
          `${r.error ? `THREW "${r.error}"` : shapeOf(r.value)}${toasts.length > before ? ` + TOAST ${toasts.slice(before).join(" / ")}` : ""}`);
      }
    } finally {
      n.error = orig.error;
      n.warn = orig.warn;
    }
    info("C1", "As this PLAYER: fromUuid on the first entry of every pack this client knows", rows.join("\n         ") || "(no packs)",
      "Set one pack to Player: None, one to Limited, one to Observer (Configure Ownership on the pack) and re-run. Also compare game.packs.size with the GM's.");
    info("C2", "Packs this player's client holds at all", `${game.packs.size} (GM: compare)`);
  }

  // ── D. Actors and Items held by this client ───────────────────────────────
  {
    const npcs = game.actors.contents;
    const byLevel = {};
    for (const a of npcs) {
      const k = levelName(safe(() => a.permission));
      byLevel[k] = (byLevel[k] ?? 0) + 1;
    }
    info("D1", "World actors this client holds, by this user's level", `${npcs.length} total ${JSON.stringify(byLevel)}`,
      isGM ? "Note the total; the player's D1 should show whether NONE-level actors are on their client." :
        "If NONE-level actors are counted here, world actor data reaches every client (the reader-not-gated premise).");
    if (!isGM) {
      const root = ui.actors?.element?.[0] ?? ui.actors?.element;
      const shown = [...(root?.querySelectorAll?.("[data-entry-id]") ?? [])].map((el) => el.dataset.entryId);
      const limited = npcs.filter((a) => safe(() => a.testUserPermission(game.user, "LIMITED")) === true && safe(() => a.testUserPermission(game.user, "OBSERVER")) !== true);
      info("D2", "LIMITED actors: in this player's Actors sidebar?", limited.length
        ? limited.map((a) => `${a.name}: visible:${a.visible} limited:${a.limited} inSidebarDOM:${shown.includes(a.id)}`).join("; ")
        : "(none at exactly LIMITED — set one NPC to Player: Limited and re-run with the Actors tab rendered)");
    }
  }

  // ── E. HTMLField discovery — the REFERENCE traversal ──────────────────────
  // Walk SchemaField (and so DataModelSchemaField / EmbeddedDataField) recursively; record every
  // HTMLField; skip ArrayField, SetField, ObjectField, TypedObjectField, TypedSchemaField — they
  // have no stable path. Default: the first eligible path matching, IN THIS ORDER, public >
  // biograph > description > notes; never a path with a segment STARTING with gm, private or
  // secret (gmNotes, privateDescription, secretNotes…); else the first eligible; else none.
  const F = foundry.data?.fields ?? {};
  const RANK = [/public/i, /biograph/i, /description/i, /notes/i];
  const NEVER_DEFAULT = /(^|\.)(gm|private|secret)[^.]*(\.|$)/i;
  const discover = (schema) => {
    const out = [];
    const walk = (field, path, depth) => {
      if (!field || depth > 8) return;
      if (F.HTMLField && field instanceof F.HTMLField) {
        const raw = field.label || "";
        out.push({ path, label: raw ? game.i18n.localize(raw) : "", rawLabel: raw });
        return;
      }
      if (F.SchemaField && field instanceof F.SchemaField) {
        for (const [name, child] of Object.entries(field.fields ?? {})) walk(child, path ? `${path}.${name}` : name, depth + 1);
      }
    };
    walk(schema, "", 0);
    return out;
  };
  const pickDefault = (found) => {
    const eligible = found.filter((f) => !NEVER_DEFAULT.test(f.path));
    for (const re of RANK) {
      const hit = eligible.find((f) => re.test(f.path));
      if (hit) return hit.path;
    }
    return eligible[0]?.path ?? null;
  };
  // template.json systems: no data model, so string leaves of game.model[doc][type] whose KEY ranks.
  const templateLeaves = (obj, path = "", out = []) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === "string" && RANK.some((re) => re.test(p))) out.push({ path: p, label: "", rawLabel: "" });
      else if (v && typeof v === "object" && !Array.isArray(v)) templateLeaves(v, p, out);
    }
    return out;
  };
  for (const docName of ["Actor", "Item"]) {
    const types = safe(() => game.documentTypes?.[docName] ?? Object.keys(CONFIG[docName].dataModels ?? {}), []);
    const lines = [];
    for (const type of types) {
      if (type === "base") continue;
      const model = CONFIG[docName]?.dataModels?.[type];
      const t0 = performance.now();
      const found = model?.schema ? discover(model.schema) : templateLeaves(game.model?.[docName]?.[type]);
      const ms = (performance.now() - t0).toFixed(2);
      lines.push(`${type} [${model ? "DataModel" : "template.json"}; ${ms} ms] default=${pickDefault(found) ?? "(none)"}\n           ` +
        (found.map((f) => `${f.path}${f.label ? ` "${f.label}"` : ""}${f.rawLabel && f.rawLabel !== f.label ? ` (key ${f.rawLabel})` : ""}`).join("\n           ") || "(no HTML fields)"));
    }
    info(`E.${docName}`, `HTMLField paths under system, per ${docName} type`, lines.join("\n         ") || "(no types)",
      "Is the default the text a player should read? Is any GM-only text NOT caught by the never-default rule?");
  }
  // Same traversal against a live document's instance schema, to check the static one matches.
  {
    const a = game.actors.contents.find((x) => x.system?.schema);
    if (a) info("E.instance", "Instance schema agrees with CONFIG's static one (first actor)",
      `${a.name}/${a.type}: ${discover(a.system.schema).map((f) => f.path).join(", ") || "(none)"}`);
  }

  // ── F. Portraits ───────────────────────────────────────────────────────────
  info("F1", "Default artwork constants", [
    `CONST.DEFAULT_TOKEN:${CONST.DEFAULT_TOKEN}`,
    `Actor.DEFAULT_ICON:${safe(() => CONFIG.Actor.documentClass.DEFAULT_ICON)}`,
    `Item.DEFAULT_ICON:${safe(() => CONFIG.Item.documentClass.DEFAULT_ICON)}`,
  ].join(" | "));
  info("F2", "First actors: img / prototype token texture / getDefaultArtwork", game.actors.contents.slice(0, 6).map((a) =>
    `${a.name}(${a.type}): img=${a.img} token=${a.prototypeToken?.texture?.src} default=${safe(() => json(CONFIG.Actor.documentClass.getDefaultArtwork?.(a.toObject())))}`
  ).join("\n         ") || "(no actors)");

  // ── G. Sheets and the level each needs ────────────────────────────────────
  const sheetFacts = (docName) => {
    const out = [];
    for (const [type, entries] of Object.entries(CONFIG[docName]?.sheetClasses ?? {})) {
      const def = Object.values(entries).find((e) => e.default) ?? Object.values(entries)[0];
      const cls = def?.cls;
      if (!cls) continue;
      const v2 = !!foundry.applications?.api?.ApplicationV2 && cls.prototype instanceof foundry.applications.api.ApplicationV2;
      const vp = v2 ? cls.DEFAULT_OPTIONS?.viewPermission : safe(() => cls.defaultOptions?.viewPermission);
      out.push(`${type}: ${cls.name} ${v2 ? "AppV2" : "AppV1"} viewPermission:${levelName(vp)} parts:${v2 ? Object.keys(cls.PARTS ?? {}).join(",") : "-"}`);
    }
    return out.join("\n         ") || "(none)";
  };
  info("G1", "Default Actor sheet per type", sheetFacts("Actor"));
  info("G2", "Default Item sheet per type", sheetFacts("Item"));
  info("G3", "Journal sheets", `${safe(() => CONFIG.JournalEntry.sheetClasses.base && Object.values(CONFIG.JournalEntry.sheetClasses.base).map((e) => `${e.cls.name}:${levelName(e.cls.DEFAULT_OPTIONS?.viewPermission)}`).join(","))}`);

  // ── Interactive helpers ────────────────────────────────────────────────────
  const helpers = {};

  /** Record the next `count` canvas drops: payload, modifiers. Returns false so nothing is created. */
  helpers.armDrop = (count = 4) => {
    let left = count;
    const id = Hooks.on("dropCanvasData", (_canvas, data, event) => {
      console.log("%c[probe2] drop payload:", "color:#7fdfff", JSON.parse(JSON.stringify(data ?? {})),
        { altKey: event?.altKey, shiftKey: event?.shiftKey, ctrlKey: event?.ctrlKey,
          AltHeld: game.keyboard?.isModifierActive?.("Alt") });
      if (--left <= 0) { Hooks.off("dropCanvasData", id); console.log("[probe2] drop recorder removed."); }
      return false;
    });
    console.log(`[probe2] armed for ${count} drops: drag an Actor and an Item from the sidebar, then an Actor and an Item from a compendium window, onto the canvas. Nothing will be created.`);
  };

  /** Log hook names matching /Context|HeaderControls|HeaderButtons/ for `ms`, and add one inert
   * "DP probe: log target" entry to every Actor/Item/JournalEntry context menu so clicking it prints
   * the target's shape. Restores Hooks afterwards. Client UI only: a menu built while recording keeps
   * the probe entry until the page is reloaded (F5). */
  helpers.recordHooks = (ms = 30000) => {
    const seen = new Map();
    const call = Hooks.call;
    const callAll = Hooks.callAll;
    const note = (name, args) => {
      if (!/Context|HeaderControls|HeaderButtons/.test(name)) return;
      const app = args[0];
      const key = `${name} <- ${app?.constructor?.name} doc:${app?.document?.documentName ?? app?.collection?.documentName ?? "-"} pack:${app?.collection?.collection ?? "-"}`;
      if (!seen.has(key)) { seen.set(key, true); console.log("%c[probe2] hook:", "color:#7fdfff", key); }
      if (/^get(Actor|Item|JournalEntry|Journal)ContextOptions$/.test(name) && Array.isArray(args[1])) {
        args[1].push({
          label: "DP probe: log target",
          icon: '<i class="fa-solid fa-flask"></i>',
          onClick: (_e, target) => console.log("%c[probe2] context target:", "color:#9fffd0", {
            hook: name, tag: target?.tagName, dataset: { ...(target?.dataset ?? {}) },
            app: app?.constructor?.name, packCollection: app?.collection?.collection,
            appDocumentName: app?.documentName ?? app?.collection?.documentName,
          }),
        });
      }
    };
    Hooks.call = function (name, ...a) { note(name, a); return call.call(this, name, ...a); };
    Hooks.callAll = function (name, ...a) { note(name, a); return callAll.call(this, name, ...a); };
    console.log(`[probe2] recording for ${ms / 1000} s. Now: right-click an Actor, an Item and a Journal entry in the sidebar; open a compendium window of each type and right-click an entry (context menus are built on FIRST render — close and reopen the windows/tabs if they were already open); open an Actor sheet, an Item sheet, a Journal sheet and a compendium journal's sheet; click "DP probe: log target" once in each menu.`);
    setTimeout(() => {
      Hooks.call = call;
      Hooks.callAll = callAll;
      console.log("%c[probe2] hooks seen:\n", "color:#9fffd0", [...seen.keys()].join("\n"));
    }, ms);
  };

  /** As a PLAYER: open an actor's sheet and report what a limited view renders. Read-only. */
  helpers.limitedSheet = async (uuid) => {
    const a = await fu(uuid);
    if (!a) return console.log("[probe2] no such actor on this client:", uuid);
    const sheet = a.sheet;
    console.log("[probe2] actor", { name: a.name, permission: levelName(a.permission), limited: a.limited, visible: a.visible,
      sheet: sheet?.constructor?.name, isVisible: safe(() => sheet?.isVisible) });
    const r = await attempt(() => sheet?.render({ force: true }) ?? sheet?.render(true));
    await new Promise((res) => setTimeout(res, 800));
    const el = sheet?.element?.[0] ?? sheet?.element;
    console.log("[probe2] rendered:", { error: r.error, rendered: sheet?.rendered,
      parts: el ? [...el.querySelectorAll("[data-application-part]")].map((p) => p.dataset.applicationPart) : [],
      classes: el?.className, textLength: el?.textContent?.length,
      firstText: el?.textContent?.replace(/\s+/g, " ").slice(0, 400) });
    console.log("[probe2] Now LOOK at the sheet and write down: portrait? name? biography? any stats? Then close it.");
  };

  /** Log updateActor/updateItem payloads for `ms` (e.g. change an NPC's HP, rename it, edit its biography). */
  helpers.watchUpdates = (ms = 30000) => {
    const ids = ["updateActor", "updateItem"].map((h) => [h, Hooks.on(h, (doc, changed, options, userId) =>
      console.log(`%c[probe2] ${h}`, "color:#7fdfff", { uuid: doc.uuid, parent: doc.parent?.uuid ?? null, isToken: doc.isToken,
        changedKeys: Object.keys(foundry.utils.flattenObject(changed ?? {})), optionKeys: Object.keys(options ?? {}), userId }))]);
    console.log(`[probe2] watching updateActor/updateItem for ${ms / 1000} s — change an NPC's HP, rename it, edit its biography, edit an owned item.`);
    setTimeout(() => { for (const [h, id] of ids) Hooks.off(h, id); console.log("[probe2] update watcher removed."); }, ms);
  };

  /** WRITES (opt-in, GM): import one pack entry into a temporary folder, report, then delete both. */
  helpers.importOne = async (uuid, { iUnderstand = false, keep = false } = {}) => {
    if (!iUnderstand) return console.warn("[probe2] importOne WRITES to the world. Re-run with { iUnderstand: true } in a TEST world.");
    if (!isGM) return console.warn("[probe2] GM only.");
    const parsed = foundry.utils.parseUuid(uuid);
    const pack = parsed?.collection;
    const collection =
      game.collections?.get?.(parsed?.type) ??
      { JournalEntry: game.journal, Actor: game.actors, Item: game.items }[parsed?.type];
    if (!pack || !collection?.importFromCompendium) return console.warn("[probe2] not a pack document uuid:", uuid, parsed);
    let folder = null;
    let doc = null;
    try {
      folder = await CONFIG.Folder.documentClass.create({ name: "DP probe — delete me", type: parsed.type });
      doc = await collection.importFromCompendium(pack, parsed.id, { folder: folder.id });
      console.log("%c[probe2] imported:", "color:#9fffd0", { uuid: doc?.uuid, folder: doc?.folder?.id,
        compendiumSource: doc?._stats?.compendiumSource, ownership: doc?.ownership, pages: doc?.pages?.size });
    } finally {
      if (!keep) {
        await doc?.delete?.();
        await folder?.delete?.();
        console.log("[probe2] probe import and folder deleted.");
      }
    }
  };

  /** WRITES nothing but SHOWS a window on a player's screen (opt-in, GM): Journal.show for a pack doc. */
  helpers.showPack = async (uuid, userId, { iUnderstand = false } = {}) => {
    if (!iUnderstand) return console.warn("[probe2] showPack opens a window on the player's screen. Re-run with { iUnderstand: true }.");
    const doc = await fu(uuid);
    const Journal = foundry.documents.collections.Journal;
    const r = await attempt(() => Journal.show(doc, { force: true, users: [userId] }));
    console.log("[probe2] Journal.show:", r.error ?? "sent", "— ask the player whether a window opened (and record the pack's level for them).");
  };

  // ── Report ────────────────────────────────────────────────────────────────
  const pad = (s, n) => String(s).padEnd(n);
  const lines = R.map((r) => `${pad(r.id, 11)}${pad(r.verdict, 8)}${r.q}\n         -> ${r.answer}${r.note ? `\n         ${r.note}` : ""}`);
  const report = [
    `================ documents-pinner :: Spike 2 (${isGM ? "GM" : "PLAYER"}) ================`,
    ...lines,
    "=====================================================================",
    "INTERACTIVE (run each, then copy what it prints):",
    "  __dpProbe2.armDrop(4)          drops: Actor + Item from the sidebar, Actor + Item from a compendium",
    "  __dpProbe2.recordHooks(30000)  context-menu and header hook names, and each menu's target shape",
    "  __dpProbe2.watchUpdates(30000) updateActor/updateItem payloads (HP change vs rename vs biography)",
    "  __dpProbe2.limitedSheet(uuid)  PLAYER: what a LIMITED actor sheet shows (set an NPC to Player: Limited first)",
    "  __dpProbe2.importOne(uuid, { iUnderstand: true })        GM, WRITES then deletes: _stats.compendiumSource",
    "  __dpProbe2.showPack(uuid, userId, { iUnderstand: true }) GM: Journal.show of a pack document",
    "MANUAL, optional: with no recorder armed and the module DISABLED, Alt-drop an Actor on the",
    "  canvas. Is the token created hidden? (core's Alt meaning; decides D8). Delete the token.",
  ].join("\n");
  console.log(report);
  globalThis.__dpProbe2 = { results: R, report, ...helpers };
  try {
    await navigator.clipboard.writeText(report);
    console.log("%c[probe2] Report copied to clipboard.", "color:#9fffd0");
  } catch {
    console.log("[probe2] Clipboard blocked — copy the report above, or use __dpProbe2.report");
  }
})();
