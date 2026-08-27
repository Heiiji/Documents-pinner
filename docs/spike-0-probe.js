/**
 * documents-pinner — Spike 0 probe
 *
 * Resolves the four load-bearing API facts the architecture depends on, plus the prop
 * rendering pipeline and a set of smaller facts we derive at runtime rather than
 * hardcode.
 *
 * HOW TO RUN
 *   1. Open a world on Foundry v14 as a GM, with any scene active.
 *   2. Open the browser console (F12).
 *   3. Paste this whole file and press Enter.
 *   4. Copy the printed report back.
 *
 * It is READ-ONLY except for probe 4, which creates one temporary tile and deletes it
 * again in a `finally` block. Nothing is written to any document you own.
 */
(async () => {
  const R = [];
  const ok = (id, q, a, note) => R.push({ id, q, verdict: "OK", answer: a, note });
  const no = (id, q, a, note) => R.push({ id, q, verdict: "PROBLEM", answer: a, note });
  const info = (id, q, a, note) => R.push({ id, q, verdict: "info", answer: a, note });
  const safe = (fn, fallback = "n/a") => {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      return `threw: ${e?.message ?? e}`;
    }
  };

  // ── 1. PixiJS major version ────────────────────────────────────────────────
  // Decides GLSL dialect for every shader: v7 => ES 1.0 (attribute/varying/texture2D),
  // v8 => ES 3.0 (in/out/texture). Nothing else in the design changes.
  {
    const v = safe(() => PIXI?.VERSION, "unknown");
    const major = parseInt(String(v), 10);
    const q = "PIXI major version";
    if (major === 7) ok("1", q, v, "GLSL ES 1.0 — as assumed.");
    else if (major === 8) no("1", q, v, "GLSL must be authored in ES 3.0. Shaders only; design unchanged.");
    else info("1", q, v, "Unrecognised — inspect before writing any shader.");
  }

  // ── 2. PrimarySpriteMesh#setShaderClass ───────────────────────────────────
  // THE highest-uncertainty piece. If a custom sampler shader cannot be installed
  // while keeping depth/occlusion, animated effects fall back to PIXI.Filter, which
  // breaks batching and caps animated props at roughly a dozen.
  {
    const q = "PrimarySpriteMesh#setShaderClass usable for custom effect shaders";
    const PSM = safe(() => foundry?.canvas?.primary?.PrimarySpriteMesh);
    const proto = PSM?.prototype;
    const hasSetter = typeof proto?.setShaderClass === "function";
    const base = safe(() => foundry?.canvas?.rendering?.shaders?.PrimaryBaseSamplerShader);
    const hasDepth = typeof proto?.renderDepthData === "function";

    if (!PSM) no("2", q, "PrimarySpriteMesh not found", "Check the v14 namespace path.");
    else if (!hasSetter) no("2", q, "setShaderClass absent", "Fall back to PIXI.Filter with an explicit resolution.");
    else if (!base) no("2", q, "setShaderClass present, PrimaryBaseSamplerShader NOT found", "Find the correct base class before subclassing.");
    else {
      ok("2", q, `setShaderClass: yes, base: yes, renderDepthData: ${hasDepth}`,
         "Proceed with the shader path. Still confirm occlusion visually on a real tile.");
      info("2b", "PrimaryBaseSamplerShader static hooks",
        Object.getOwnPropertyNames(base).filter((k) => !["length", "name", "prototype"].includes(k)).join(", ") || "(none)");
    }
  }

  // ── 3. dropCanvasData cancellation ────────────────────────────────────────
  // The primary entry point is Alt-drag. If returning false does NOT suppress core's
  // default Note creation, every alt-drag would produce a stray Note beside our pin.
  {
    const q = "dropCanvasData returning false suppresses core's default handling";
    info("3", q, "MANUAL — see instructions printed below",
      "A temporary hook has been installed; drag a journal onto the canvas to test.");
    const id = Hooks.on("dropCanvasData", (_c, data) => {
      console.log("%c[probe] dropCanvasData fired:", "color:#7fdfff", JSON.parse(JSON.stringify(data ?? {})));
      console.log("%c[probe] returning false — if NO Note appears, cancellation works.", "color:#7fdfff");
      return false;
    });
    globalThis.__dpProbeOffDrop = () => { Hooks.off("dropCanvasData", id); console.log("[probe] drop hook removed."); };
  }

  // ── 4. Tile#isVisible override reaches mesh.visible ───────────────────────
  // Our whole audience model rides on this: if overriding isVisible does not hide the
  // mesh, players would see props they are not in the audience for.
  {
    const q = "Overriding Tile#isVisible propagates to mesh.visible via _refreshVisibility";
    let created = null;
    try {
      if (!canvas?.ready) throw new Error("no active scene");
      const d = canvas.dimensions;
      // Rendered on purpose: with { render: false } the placeable never draws, so
      // there is no mesh to observe and the probe can only report undefined.
      const [doc] = await canvas.scene.createEmbeddedDocuments("Tile", [{
        texture: { src: "icons/svg/book.svg" },
        x: d.sceneX, y: d.sceneY, width: d.size, height: d.size, alpha: 0.01,
      }]);
      created = doc;

      let tile = doc.object;
      for (let i = 0; i < 90 && !tile?.mesh; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        tile = doc.object;
      }
      if (!tile) throw new Error("placeable never appeared for the created tile");
      if (!tile.mesh) throw new Error("placeable drew but has no .mesh after 90 frames");

      const before = tile.mesh.visible;
      Object.defineProperty(tile, "isVisible", { value: false, configurable: true });

      // Only set flags this build actually declares; an unknown key throws.
      const declared = Object.keys(tile.constructor.RENDER_FLAGS ?? {});
      const wanted = ["refreshVisibility", "refreshState", "refresh"].filter((f) => declared.includes(f));
      if (wanted.length) tile.renderFlags.set(Object.fromEntries(wanted.map((f) => [f, true])));
      else tile.renderFlags.set({ refresh: true });
      tile.renderFlags.flush?.();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const after = tile.mesh.visible;

      if (before === true && after === false) {
        ok("4", q, `mesh.visible ${before} -> ${after} (flags set: ${wanted.join(",") || "refresh"})`,
           "Audience enforcement can ride on isVisible.");
      } else {
        no("4", q, `mesh.visible ${before} -> ${after} (flags set: ${wanted.join(",") || "refresh"})`,
           "Hide the mesh explicitly in _refreshVisibility instead of relying on the getter.");
      }
      info("4b", "Tile RENDER_FLAGS", declared.join(", ") || "(none)");
    } catch (e) {
      no("4", q, `threw: ${e?.message ?? e}`, "Re-run with a scene active as GM.");
    } finally {
      try { await created?.delete(); } catch { /* leave no litter */ }
    }
  }

  // ── 4c. What core actually does, read from core ───────────────────────────
  // Cheaper and more reliable than inferring the contract from behaviour: the bodies
  // say directly whether our overrides sit on the path core takes.
  {
    const srcOf = (proto, name) => {
      for (let o = proto; o; o = Object.getPrototypeOf(o)) {
        const desc = Object.getOwnPropertyDescriptor(o, name);
        if (!desc) continue;
        const fn = desc.get ?? desc.value;
        if (typeof fn !== "function") continue;
        const owner = o.constructor?.name ?? "?";
        return `${owner}#${name}: ${String(fn).replace(/\s+/g, " ").slice(0, 320)}`;
      }
      return `${name}: (not found)`;
    };
    const proto = CONFIG.Tile.objectClass?.prototype;
    for (const name of ["isVisible", "_refreshVisibility", "_canHover", "_canControl", "_onClickLeft2"]) {
      info(`4c.${name}`, `Tile source: ${name}`, proto ? srcOf(proto, name) : "no objectClass");
    }
  }

  // ── Derived-at-runtime facts (never hardcode these) ───────────────────────
  info("5", "CONFIG.Canvas.layers keys", safe(() => Object.keys(CONFIG.Canvas.layers).join(", ")));
  info("5b", "Distinct layer groups in use",
    safe(() => [...new Set(Object.values(CONFIG.Canvas.layers).map((l) => l.group))].join(", ")));
  info("5c", "PrimaryCanvasGroup.SORT_LAYERS",
    safe(() => JSON.stringify(foundry.canvas.groups.PrimaryCanvasGroup.SORT_LAYERS)));
  info("6", "foundry.applications.hud exports", safe(() => Object.keys(foundry.applications.hud).join(", ")));
  info("7", "pixi-filters bundled?",
    safe(() => ["GlowFilter", "OutlineFilter", "DropShadowFilter", "AdjustmentFilter"]
      .map((f) => `${f}:${!!(PIXI.filters?.[f])}`).join(" ")));
  info("7b", "PIXI.Filter.defaultResolution", safe(() => PIXI.Filter.defaultResolution));
  info("8", "Font definitions source",
    safe(() => `CONFIG.fontDefinitions:${!!CONFIG.fontDefinitions} FontConfig.getAvailableFonts:${typeof foundry.applications.settings?.menus?.FontConfig?.getAvailableFonts}`));
  info("9", "Tile placeable context hook candidates",
    "Run __dpProbeRecordHooks() then right-click a tile, a journal entry and a page");
  info("10", "core photosensitiveMode setting exists",
    safe(() => game.settings.settings.has("core.photosensitiveMode")));
  info("11", "_stats fields on a document",
    safe(() => Object.keys(game.journal.contents[0]?._stats ?? {}).join(", ") || "(no journal entries)"));
  info("12", "canvas.dimensions.uiScale / renderer autoDensity",
    safe(() => `uiScale:${canvas.dimensions.uiScale} autoDensity:${canvas.app.renderer.options.autoDensity} resolution:${canvas.app.renderer.resolution}`));
  info("13", "DOM mount point for a canvas-synced overlay",
    safe(() => {
      const board = document.getElementById("board");
      const describe = (el) => el
        ? `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className ? "." + String(el.className).trim().split(/\s+/).join(".") : ""}`
        : "(none)";
      const chain = [];
      for (let el = board; el && chain.length < 5; el = el.parentElement) chain.push(describe(el));
      const hud = document.getElementById("hud");
      return `chain: ${chain.join(" < ")} | #hud: ${describe(hud)} parent ${describe(hud?.parentElement)} `
           + `zIndex ${hud ? getComputedStyle(hud).zIndex : "n/a"} | #interface: ${describe(document.getElementById("interface"))}`;
    }));
  info("14", "Journal.show signature present",
    safe(() => `show:${typeof foundry.documents.collections.Journal.show} _showEntry:${typeof foundry.documents.collections.Journal._showEntry}`));
  info("15", "Foundry build", safe(() => `${game.version} / generation ${game.release?.generation}`));
  // Probes 16 and 17 are client-dependent, so the report must say which client it is.
  info("15b", "Client", safe(() => `${navigator.userAgent} | electron:${!!navigator.userAgent.match(/Electron/i)}`));


  // ── 16. The prop rendering pipeline, stage by stage ───────────────────────
  // §3.2 rests entirely on this working in the target client: enriched HTML wrapped in
  // an SVG foreignObject, decoded as an image, drawn to an OffscreenCanvas and uploaded
  // as a texture. Every stage is reported separately, because the failures are not
  // interchangeable: WebKit taints the canvas (readback and WebGL upload both fail)
  // while a layout failure decodes fine and simply paints nothing.
  {
    const q = "HTML -> SVG foreignObject -> OffscreenCanvas -> PIXI.Texture";
    const stages = [];
    const stage = (name, value) => stages.push(`${name}:${value}`);
    let canvasEl = null;

    const w = 512, h = 256;
    const inner = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;`
                + `background:#e8dcc0;color:#3a2410;font:32px/1.4 serif;padding:8px;`
                + `box-sizing:border-box">documents-pinner probe</div>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
              + `<foreignObject x="0" y="0" width="${w}" height="${h}">${inner}</foreignObject></svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));

    let decoded = false, drawn = false, readable = false, painted = 0, uploaded = false;
    const t0 = performance.now();
    try {
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
        decoded = true;
        stage("decode", `ok ${img.width}x${img.height}`);
      } catch (e) {
        stage("decode", `threw ${e?.name ?? ""} ${e?.message ?? e}`);
      }

      if (decoded) {
        canvasEl = new OffscreenCanvas(w, h);
        const ctx2d = canvasEl.getContext("2d");
        try {
          ctx2d.drawImage(img, 0, 0, w, h);
          drawn = true;
          stage("drawImage", "ok");
        } catch (e) {
          stage("drawImage", `threw ${e?.name ?? ""} ${e?.message ?? e}`);
        }

        // Readback is NOT part of the real pipeline — it is how we detect tainting,
        // which is also what would block the WebGL upload two lines below.
        if (drawn) {
          try {
            const px = ctx2d.getImageData(0, 0, w, h).data;
            for (let i = 3; i < px.length; i += 4) if (px[i] > 0) painted++;
            readable = true;
            stage("getImageData", `ok ${painted}/${w * h}px painted`);
          } catch (e) {
            stage("getImageData", `TAINTED (${e?.name ?? ""} ${e?.message ?? e})`);
          }
        }

        if (drawn) {
          try {
            const tex = PIXI.Texture.from(canvasEl);
            // Force the upload: Texture.from is lazy, so an error surfaces on render.
            canvas.app.renderer.texture.bind(tex.baseTexture);
            uploaded = true;
            stage("glUpload", `ok ${tex.baseTexture.realWidth}x${tex.baseTexture.realHeight}`);
            tex.destroy(true);
          } catch (e) {
            stage("glUpload", `threw ${e?.name ?? ""} ${e?.message ?? e}`);
          }
        }
      }
    } catch (e) {
      stage("fatal", `${e?.name ?? ""} ${e?.message ?? e}`);
    } finally {
      URL.revokeObjectURL(url);
    }

    const ms = Math.round(performance.now() - t0);
    const answer = `${stages.join(" | ")} | ${ms}ms`;
    if (uploaded && painted > 0) {
      ok("16", q, answer, "Canvas rendering tier is viable on this client.");
    } else if (decoded && drawn && !readable) {
      no("16", q, answer,
         "The canvas is TAINTED (WebKit does this for foreignObject). Canvas tier unavailable here; DOM rendering mode required for this client.");
    } else {
      no("16", q, answer, "Canvas tier unavailable on this client; DOM rendering mode required.");
    }
  }

  info("17", "Client capabilities the rendering tiers branch on",
    safe(() => [
      `OffscreenCanvas:${typeof OffscreenCanvas !== "undefined"}`,
      `img.decode:${typeof HTMLImageElement.prototype.decode === "function"}`,
      `requestIdleCallback:${typeof requestIdleCallback === "function"}`,
      `document.fonts:${!!document.fonts}`,
      `hardwareConcurrency:${navigator.hardwareConcurrency}`,
      `deviceMemory:${navigator.deviceMemory ?? "n/a"}`,
      `reducedMotion:${matchMedia("(prefers-reduced-motion: reduce)").matches}`,
    ].join(" ")));

  // MAX_TEXTURE_SIZE caps the L2b tier: a 2048 texture on a 2048-limit GPU leaves no
  // headroom for anything else, so the ladder's top rung may need lowering per client.
  info("18", "Renderer limits", safe(() => {
    const gl = canvas.app.renderer.gl;
    const webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    return `webgl2:${webgl2} MAX_TEXTURE_SIZE:${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`;
  }));

  // The exact member names PinnedTile overrides in Step 2. A rename between builds
  // would fail silently — an override on a method core no longer calls.
  info("19", "Tile placeable surface to subclass", safe(() => {
    const proto = CONFIG.Tile.objectClass?.prototype ?? {};
    const members = ["isVisible", "_canHover", "_canControl", "_onClickLeft2", "_draw",
                     "_refreshMesh", "_refreshVisibility", "_destroy"];
    return `objectClass:${CONFIG.Tile.objectClass?.name} documentClass:${CONFIG.Tile.documentClass?.name} `
         + members.map((m) => `${m}:${m in proto}`).join(" ");
  }));

  info("20", "APIs the render and app tiers depend on", safe(() => [
    `enrichHTML:${typeof foundry.applications.ux.TextEditor.implementation?.enrichHTML}`,
    `FilePicker:${typeof foundry.applications.apps.FilePicker?.implementation}`,
    `detachWindow:${typeof foundry.applications.api.ApplicationV2.prototype.detachWindow}`,
    `testVisibility:${typeof canvas.visibility?.testVisibility}`,
    `BasePlaceableHUD:${typeof foundry.applications.hud.BasePlaceableHUD}`,
  ].join(" ")));

  // Probe 9, made empirical: core's context-menu hook names are not discoverable by
  // inspection, only by watching them fire. Opt-in, and it restores Hooks itself.
  globalThis.__dpProbeRecordHooks = (ms = 20000) => {
    const seen = new Set();
    const call = Hooks.call.bind(Hooks);
    const callAll = Hooks.callAll.bind(Hooks);
    const note = (name) => {
      if (/context/i.test(name) && !seen.has(name)) {
        seen.add(name);
        console.log("%c[probe] hook:", "color:#7fdfff", name);
      }
    };
    Hooks.call = (name, ...a) => { note(name); return call(name, ...a); };
    Hooks.callAll = (name, ...a) => { note(name); return callAll(name, ...a); };
    console.log(`[probe] recording *context* hook names for ${ms} ms — now right-click a tile on the Tiles layer, a journal entry, and a page.`);
    setTimeout(() => {
      Hooks.call = call;
      Hooks.callAll = callAll;
      console.log("%c[probe] context hooks seen:", "color:#9fffd0", [...seen].join(", ") || "(none)");
    }, ms);
  };

  // ── Report ────────────────────────────────────────────────────────────────
  const pad = (s, n) => String(s).padEnd(n);
  const lines = R.map((r) => `${pad(r.id, 4)}${pad(r.verdict, 9)}${r.q}\n      -> ${r.answer}${r.note ? `\n      ${r.note}` : ""}`);
  const report = [
    "================ documents-pinner :: Spike 0 ================",
    ...lines,
    "=============================================================",
    "MANUAL STEP for probe 3: alt-drag a journal entry from the sidebar onto the",
    "canvas. Watch the console. If NO map note is created, returning false cancels",
    "core handling and Alt-drag is safe as the primary entry point.",
    "When finished run:  __dpProbeOffDrop()",
    "",
    "OPTIONAL, for probe 9: run  __dpProbeRecordHooks()  then right-click a tile on the",
    "Tiles layer, a journal entry and a page. It prints the context hook names and",
    "restores Hooks after 20 s.",
  ].join("\n");
  console.log(report);
  globalThis.__dpProbe = { results: R, report };
  try {
    await navigator.clipboard.writeText(report);
    console.log("%c[probe] Report copied to clipboard.", "color:#9fffd0");
  } catch {
    console.log("[probe] Clipboard blocked — copy the report above, or use __dpProbe.report");
  }
})();
