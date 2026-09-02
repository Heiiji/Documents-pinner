/**
 * Build the engine-comparison harness.
 *
 * `npm run harness` writes `tests/harness/effects.html`, which is opened directly at
 * `file://` in two browsers and compared. No server, no Foundry, no build of the module.
 *
 * It works because `preset-css`, `EffectRegistry`, `textures` and `CardTemplate` are all
 * documented PURE — no Foundry globals at import time or in any function body. That
 * property was bought for the unit tests; this is its second customer and it costs
 * nothing new.
 *
 * The dressing is baked in HERE rather than computed in the page, because ES modules
 * cannot be loaded over `file://` — and baking it also means the committed HTML diffs
 * when the emitter changes, which is a second, free regression signal.
 *
 * **The overlay transform is the most important thing in this file.** A harness that
 * mounts `.dp-card` in a plain div at scale 1 is testing a different question and will
 * give a clean bill of health to a broken mask: the real overlay carries the stage matrix,
 * and that transform creates a containing block, a stacking context and a scale, which is
 * precisely what decides how a mask, a blur radius and a drop-shadow rasterise.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dressing } from "../src/effects/EffectRegistry";
import { CORE_PRESETS } from "../src/effects/presets/core-presets";
import { cardHtml } from "../src/render/CardTemplate";
import { estimateCost } from "../src/effects/preset-schema";
import type { LodTier } from "../src/canvas/lod";
import type { EffectsLevel } from "../src/effects/EffectRegistry";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "tests", "harness", "effects.html");

/** One seed for every card, so the same tear lands on the same pixels in both engines. */
const SEED = 1234;

/** The same body the SVG well-formedness test uses, so the two share one fixture. */
const BODY =
  `<p>A line<br>and another, long enough to reach the second line of a narrow card and ` +
  `show where the overflow fade begins.</p>` +
  `<p>Non&nbsp;breaking</p>` +
  `<hr>` +
  `<ul><li>one<li>two</ul>` +
  `<table><tr><td>cell</td><td>cell</td></tr></table>`;

const W = 260;
const H = 340;

function card(presetId: string, tier: LodTier, level: EffectsLevel, paper: string): string {
  const preset = CORE_PRESETS.find((p) => p.id === presetId)!;
  const dressed = dressing({ preset, intensity: 1, seed: SEED, tier, level, baked: false });
  const cost = estimateCost(preset);

  return (
    `<div class="dp-prop dp-prop--in" style="left:0;top:0;width:${W}px;height:${H}px">` +
    cardHtml({
      title: preset.id,
      bodyHtml: BODY,
      showTitle: true,
      paper: preset.paper ?? paper,
      fontPx: 13,
      padPx: 14,
      effectId: preset.id,
      effectStyle: dressed.style,
      effectAttrs: dressed.attrs,
    }) +
    `</div>` +
    `<p class="cap">${preset.id}<br><span>${tier} · ${level} · cost ${cost.score} ` +
    `(${cost.tier}) · seed ${SEED}</span></p>`
  );
}

/**
 * A few presets, large, at the top of the page.
 *
 * The grid below is for comparing everything at once; this is for looking at one thing
 * properly. Without it the newest presets sit three rows down, which in a small window
 * means they are the ones nobody checks.
 */
function focus(label: string, ids: string[], scale: number): string {
  // Each one twice: on the stock it would normally meet, and on `slate`. An overlay is
  // hairlines in one colour, so whether it READS at all is a contrast question — and a
  // pale mint line on cream paper is the case that would otherwise ship unnoticed.
  const stocks = ["parchment", "slate"];
  const cells = stocks
    .flatMap((stock, r) =>
      ids.map(
        (id, i) =>
          `<div class="cell" style="left:${i * (W + 40)}px;top:${r * (H + 70)}px">` +
          `${card(id, "L2b", "full", stock)}</div>`
      )
    )
    .join("");
  return (
    `<h2>${label} — scale ${scale} — row 1 parchment, row 2 slate</h2>` +
    `<div class="viewport" style="height:${Math.ceil(2 * (H + 70) * scale)}px">` +
    `<div id="documents-pinner-overlay" class="ov" style="width:${ids.length * (W + 40)}px;` +
    `height:${2 * (H + 70)}px;transform:matrix(${scale},0,0,${scale},0,0)">${cells}</div>` +
    `</div>`
  );
}

/** Four to a row, so every preset is on screen at once in both windows. */
const COLS = 4;
const CELL_W = W + 40;
const CELL_H = H + 70;

function row(label: string, tier: LodTier, level: EffectsLevel, scale: number): string {
  const shown = CORE_PRESETS.filter((p) => p.id !== "none");
  const cells = shown
    .map((p, i) => {
      const x = (i % COLS) * CELL_W;
      const y = Math.floor(i / COLS) * CELL_H;
      return `<div class="cell" style="left:${x}px;top:${y}px">${card(p.id, tier, level, "parchment")}</div>`;
    })
    .join("");

  // The REAL overlay: scene-sized, transform-origin at 0 0, carrying a matrix, with the
  // cards positioned inside it in scene coordinates. This is the most important line in
  // the file — a card mounted in a plain div at scale 1 is a different question, and would
  // give a clean bill of health to a mask that is broken under a transform.
  const rows = Math.ceil(shown.length / COLS);
  return (
    `<h2>${label} — scale ${scale}</h2>` +
    `<div class="viewport" style="height:${Math.ceil(rows * CELL_H * scale)}px">` +
    `<div id="documents-pinner-overlay" class="ov" style="width:${COLS * CELL_W}px;` +
    `height:${rows * CELL_H}px;transform:matrix(${scale},0,0,${scale},0,0)">${cells}</div>` +
    `</div>`
  );
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Documents Pinner — engine harness</title>
<!-- The REAL stylesheet, by link and unmodified: the @import … layer() chain is part of
     what is under test. If this page renders unstyled, file:// blocked the imports and
     every observation below is void. Check that first, every time. -->
<link rel="stylesheet" href="../../styles/documents-pinner.css">
<style>
  body { margin: 0; padding: 1rem; background: #14161a; color: #dfe4ea;
         font: 13px/1.4 system-ui, sans-serif; }
  h1 { font-size: 1.1rem; margin: 0 0 .3rem; }
  h2 { font-size: .85rem; margin: 1.4rem 0 .4rem; opacity: .8; font-weight: 600; }
  .viewport { position: relative; overflow: hidden; border: 1px solid #2a3038; }
  .ov { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  .cell { position: absolute; }
  .cap { position: absolute; top: ${H + 6}px; left: 0; width: ${W}px; margin: 0;
         font: 11px monospace; color: #8fa0b0; }
  .cap span { opacity: .65; }
  pre#dp-env { white-space: pre-wrap; background: #0c0e11; border: 1px solid #2a3038;
               padding: .6rem; font: 11px/1.45 monospace; margin: .5rem 0 1rem; }
  .note { max-width: 60rem; opacity: .75; }
  /* The WebGL sibling, at the position and stacking level Foundry gives #board. */
  #board-stand-in { position: fixed; inset: 0; z-index: -1; }
  /* The cascade sentinel: UNLAYERED, so it must beat the dp.ui layer's own rule. */
  .dp-tooltip { color: #00ff88; }
  .controls { display: flex; gap: .6rem; align-items: center; margin: .4rem 0 1rem; }
  .frozen .dp-card, .frozen .dp-card::before, .frozen .dp-card::after,
  .frozen .dp-card__hud-sweep {
    animation-play-state: paused !important;
    animation-delay: -500ms !important;
  }
</style>
</head>
<body>
<canvas id="board-stand-in"></canvas>

<h1>Documents Pinner — engine harness</h1>
<p class="note">
  Open this file in Firefox and in Chrome at the same window size and compare. It does
  <strong>not</strong> reproduce: Foundry's own stylesheet (so every <code>--color-*</code>
  takes its literal fallback — this page is honest for <code>.dp-card</code>,
  <code>.dp-prop</code> and <code>.dp-reader</code>, and not for the application windows),
  a PIXI render loop, core's selection frame, lighting or fog, or per-user enrichment. The
  canvas behind the page is a real WebGL context clearing to the scene background colour,
  which makes the <em>correctness</em> of any blending answerable here — not its cost.
</p>

<div class="controls">
  <label><input type="checkbox" id="freeze"> Freeze every animation at a known phase</label>
</div>

<pre id="dp-env">measuring…</pre>

${focus("The AR family, close up", ["projected-readout", "tagged-object", "signal-loss"], 1.1)}
${row("Full effect", "L2b", "full", 1)}
${row("Full effect, zoomed out", "L2b", "full", 0.35)}
${row("Full effect, zoomed in", "L2b", "full", 2.4)}
${row("Coarse tier", "L2a", "full", 1)}
${row("Reduced", "L2b", "reduced", 1)}

<div class="dp-tooltip dp-tooltip--in" style="position:static;translate:none">
  cascade sentinel — this text must be GREEN
</div>

<script>
document.getElementById("freeze").addEventListener("change", (e) => {
  document.body.classList.toggle("frozen", e.target.checked);
});

/**
 * The provenance block.
 *
 * Rendered as TEXT and legibly, because a browser this page is opened in may be one a
 * tool can screenshot but not query — so every measurement has to survive as pixels.
 */
(async function () {
  const out = [];
  const say = (k, v) => out.push(k.padEnd(26) + " " + v);

  say("userAgent", navigator.userAgent);
  say("devicePixelRatio", String(devicePixelRatio));
  say("viewport", innerWidth + " x " + innerHeight);

  for (const [name, q] of [
    ["selector(:has())", "selector(:has(*))"],
    ["color-mix", "color: color-mix(in oklab, red, blue)"],
    ["allow-discrete", "transition-behavior: allow-discrete"],
    ["content-visibility", "content-visibility: auto"],
    ["mask-image", "mask-image: linear-gradient(#000, #0000)"],
  ]) {
    say("supports " + name, String(CSS.supports(q)));
  }

  // A REAL test of @property, not a version guess: a registered property resolves to its
  // initial value on an element that never sets it; a dropped registration resolves to "".
  const registered = getComputedStyle(document.documentElement).getPropertyValue("--dp-i");
  say("@property honoured", registered.trim() === "" ? "NO (registration dropped)" : "yes (--dp-i=" + registered.trim() + ")");

  // The cascade sentinel, as a resolved colour. Green means the module's rules are in a
  // layer and an unlayered rule outranks them — which is what stops it outranking Foundry.
  const sentinel = document.querySelector(".dp-tooltip");
  say("layer order", getComputedStyle(sentinel).color + " (want rgb(0, 255, 136))");

  // Resolved values as TEXT, which turns "does the glow look right" into a string compare.
  const glow = document.querySelector('.dp-card[data-dp-fx="arcane-glow"]');
  if (glow) {
    say("arcane-glow box-shadow", getComputedStyle(glow, "::after").boxShadow);
    say("arcane-glow filter", getComputedStyle(glow).filter);
  }
  const torn = document.querySelector('.dp-card[data-dp-fx="torn-edges"]');
  if (torn) say("torn-edges mask-image", getComputedStyle(torn).maskImage.slice(0, 60) + "…");

  // The foreignObject taint probe, inline — the same question Rasterizer asks at ready.
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
      '<foreignObject x="0" y="0" width="8" height="8">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="width:8px;height:8px;background:#fff">' +
      '</div></foreignObject></svg>';
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = "data:image/svg+xml," + encodeURIComponent(svg);
    });
    const c = document.createElement("canvas"); c.width = c.height = 8;
    const cx = c.getContext("2d"); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, 8, 8).data;
    let painted = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) painted++;
    say("foreignObject rasterises", painted > 0 ? "YES — the canvas tier is reachable here" : "no (blank)");
  } catch (e) {
    say("foreignObject rasterises", "no — " + e.name + " (expected: DOM tier)");
  }

  // A generated feTurbulence SVG: does drawing it taint? WebKit says yes, Chromium no.
  // NOT a regex stopping at the first ")": the generated SVG contains a url(#g) reference
  // percent-encoded as url(%23g), so a lazy match truncates the data URI and the image
  // fails to load — which reads exactly like a taint and is not one.
  const unwrap = (value) =>
    value.trim().replace(/^url\\((['"]?)/, "").replace(/(['"]?)\\)$/, "");
  const grain = getComputedStyle(document.querySelector(".dp-card")).getPropertyValue("--dp-grain-img");
  const url = grain && grain !== "none" ? unwrap(grain) : null;
  if (url) {
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement("canvas"); c.width = c.height = 16;
      const cx = c.getContext("2d"); cx.drawImage(img, 0, 0);
      cx.getImageData(0, 0, 1, 1);
      say("generated SVG taints", "no — origin clean, safe to upload");
    } catch (e) {
      say("generated SVG taints", "YES — " + e.name + " (A17's red screen)");
    }
  }

  /**
   * The edge mask, as forty integers.
   *
   * Draw the torn mask at 400x400 and count opaque pixels per row. Two engines' strings
   * are directly comparable, so "the tear looks different" becomes arithmetic. This is
   * the single most useful line on the page.
   */
  const maskImage = torn && getComputedStyle(torn).maskImage;
  const maskUrl = maskImage && maskImage !== "none" ? unwrap(maskImage) : null;
  if (maskUrl) {
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = maskUrl; });
      const c = document.createElement("canvas"); c.width = c.height = 400;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0, 400, 400);
      const d = cx.getImageData(0, 0, 400, 400).data;
      const rows = [];
      for (let r = 0; r < 40; r++) {
        let n = 0;
        const y = r * 10;
        for (let x = 0; x < 400; x++) if (d[(y * 400 + x) * 4 + 3] > 128) n++;
        rows.push(n);
      }
      say("torn mask row profile", rows.join(","));
    } catch (e) {
      say("torn mask row profile", e instanceof Event ? "unavailable — the mask image did not load" : "unavailable — " + e.name);
    }
  }

  document.getElementById("dp-env").textContent = out.join("\\n");
})();

// A real WebGL context clearing to the scene background colour A17's red screen came from,
// so anything blending against it is blending against a live canvas rather than a bitmap.
(function () {
  const gl = document.getElementById("board-stand-in").getContext("webgl2")
    || document.getElementById("board-stand-in").getContext("webgl");
  if (!gl) return;
  let t = 0;
  (function frame() {
    t += 0.01;
    gl.clearColor(0.145 + Math.sin(t) * 0.02, 0.027, 0.051, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    requestAnimationFrame(frame);
  })();
})();
</script>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page);
console.log(`wrote ${OUT}`);
