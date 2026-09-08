// The .excalidraw canvas painter: draws a scene, and pans and zooms it.
//
// This file is the paintbrush and nothing else. The document — the scene, the
// geometry, hit-testing, transforms, undo — lives in Rust (xd-core, reached
// through xdWasm.js). This file is handed shapes and told where they are, and
// its whole job is to put them on a canvas that looks like Excalidraw's.
//
// It is a painter for an *editor* now, not for a viewer. term.hut's copy of
// this file said "read-only by design", on the grounds that Excalidraw's
// editor is a React application and what is portable is the format. The first
// half of that was a fact about React and the second half was the opening this
// project walked through: the format is JSON drawn with Rough.js, so the
// drawing half was always ours — only the model was missing, and a model is
// exactly the thing Rust is good at. So the paragraph is gone and this is what
// replaces it.
//
// The file keeps two halves, and the line between them is load-bearing.
//
// The drawing half came from term.hut, and it is the half that answers to
// Excalidraw rather than to us. Rough.js is deterministic in each element's
// seed, and matching it *is* the compatibility story — so anything that changes
// how a shape lands on the canvas changes how every file anyone already has
// renders, and the only acceptable reason to do that is that we were the ones
// who were wrong.
//
// Which we were, in a handful of places, and the corrections are all cited to
// the line of `shape.ts` or `renderElement.ts` they came from: the two
// `continuousPath` call sites were inverted, rounded diamonds never rounded, a
// line's primitive ignored its own `roundness`, arrowheads were the wrong size
// and aimed along the wrong vector, and dark-mode colours were not filtered at
// all. Everything else here is still term.hut's, deliberately. The rule has not
// changed — a divergence from Excalidraw is a bug in this file, in whichever
// direction it points.
//
// The chrome half is what the editor added: selection outlines, the eight
// resize handles and the rotate handle, the marquee, snap guides. Chrome is
// not part of the drawing. It is painted in the same scene-space transform but
// measured in *screen* pixels, which is why every one of these takes an
// explicit `{ scale }`: a handle that shrinks as you zoom out is a handle you
// cannot grab, and one that grows as you zoom in swallows the shape it belongs
// to.
//
// Nothing here decides anything. Where a handle is *drawn* is not where a
// handle *is* — hit-testing is xd-core's, and if the painter and the model
// ever disagree about a coordinate, the model is right and this file is the
// thing that gets fixed.
//
// Everything decidable without a canvas is in excalidrawScene.js, where it's
// tested.
import rough from "../vendor/roughjs/rough.esm.js";
import { getStroke } from "../vendor/perfect-freehand/perfect-freehand.esm.js";
import { div, el } from "./dom.js";
import {
  sceneBounds, fitTransform, roughOptions, cornerRadius, cornerRadiusFor, opacityOf,
  imageDataUrl, fontString, textLayout, isDrawn, applyDarkModeFilter,
} from "./excalidrawScene.js";

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

/// Draw `scene` into `host`. `onActions(list)` takes this view's contributions
/// to the pane header — fit, zoom, and the scene's element count — so the
/// canvas needs no toolbar of its own; it's optional, and a caller that omits
/// it gets a bare canvas with its wheel and keyboard zoom intact.
/// Returns a dispose function — the view holds a ResizeObserver and
/// window-level pointer listeners, and a tab that closed must not keep
/// repainting (the hazard preview hosts already learned).
export function renderExcalidrawCanvas(host, scene, { onActions } = {}) {
  const canvas = el("canvas", "xd-canvas");
  const wrap = div("xd-wrap");
  wrap.appendChild(canvas);

  // The zoom readout and the scene's element count live in the pane header
  // now, next to the buttons that move them (viewActions.js) — the canvas
  // fills the pane and grows no bar of its own.
  let zoomText = "100%";
  let sceneNote = "";

  const view = { scale: 1, offsetX: 0, offsetY: 0 };
  const bounds = sceneBounds(scene.elements);
  const images = new Map(); // fileId -> HTMLImageElement (decoded)
  let disposed = false;
  let frame = 0;

  // --- painting ------------------------------------------------------------

  const paint = () => {
    if (disposed) return;
    frame = 0;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return; // laid out but not shown yet
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // The scene's own background, not the app's: a diagram authored on white
    // is unreadable composited onto a dark pane.
    ctx.fillStyle = scene.appState?.viewBackgroundColor || "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.translate(view.offsetX, view.offsetY);
    ctx.scale(view.scale, view.scale);

    const rc = rough.canvas(canvas);
    for (const element of scene.elements) {
      try {
        drawElement(ctx, rc, element, scene, images);
      } catch {
        // One malformed element must not blank the whole drawing.
      }
    }
    ctx.restore();
    const pct = `${Math.round(view.scale * 100)}%`;
    // Only when it moved: paint runs on every frame of a pan, and the header
    // has nothing new to say about a drag that didn't zoom.
    if (pct !== zoomText) {
      zoomText = pct;
      publish();
    }
  };

  const schedule = () => {
    if (frame || disposed) return;
    frame = requestAnimationFrame(paint);
  };

  // --- view controls -------------------------------------------------------

  const fit = () => {
    const t = fitTransform(bounds, { width: wrap.clientWidth, height: wrap.clientHeight });
    view.scale = t.scale;
    view.offsetX = t.offsetX;
    view.offsetY = t.offsetY;
    schedule();
  };

  /// Zoom about a point in *screen* space, so the pixel under the cursor stays
  /// under the cursor.
  const zoomAt = (factor, sx, sy) => {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
    const k = next / view.scale;
    view.offsetX = sx - (sx - view.offsetX) * k;
    view.offsetY = sy - (sy - view.offsetY) * k;
    view.scale = next;
    schedule();
  };

  const centre = () => [wrap.clientWidth / 2, wrap.clientHeight / 2];

  /// What this view puts in the pane header. Rebuilt rather than mutated —
  /// renderActions diffs by id, so republishing costs nothing on screen.
  const publish = () => onActions?.([
    { id: "xd-fit", icon: "fit", title: "Fit the drawing to the pane (⌘0)", run: fit },
    {
      id: "xd-one",
      label: "1:1",
      title: "Actual size",
      run: () => zoomAt(1 / view.scale, ...centre()),
    },
    { id: "xd-out", icon: "zoomOut", title: "Zoom out (⌘−)", run: () => zoomAt(1 / 1.2, ...centre()) },
    { id: "xd-zoom", kind: "status", text: zoomText },
    { id: "xd-in", icon: "zoomIn", title: "Zoom in (⌘+)", run: () => zoomAt(1.2, ...centre()) },
    ...(sceneNote ? [{ id: "xd-note", kind: "status", text: sceneNote }] : []),
  ]);

  // --- interaction ---------------------------------------------------------

  const onWheel = (ev) => {
    ev.preventDefault();
    const r = wrap.getBoundingClientRect();
    const sx = ev.clientX - r.left;
    const sy = ev.clientY - r.top;
    // A trackpad pinch arrives as ctrlKey+wheel; a plain wheel scrolls the
    // canvas, which is what it does over any other document.
    if (ev.ctrlKey || ev.metaKey) {
      zoomAt(Math.exp(-ev.deltaY / 100), sx, sy);
      return;
    }
    view.offsetX -= ev.deltaX;
    view.offsetY -= ev.deltaY;
    schedule();
  };
  wrap.addEventListener("wheel", onWheel, { passive: false });

  let drag = null;
  const onPointerDown = (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY };
    wrap.setPointerCapture(ev.pointerId);
    wrap.classList.add("panning");
  };
  const onPointerMove = (ev) => {
    if (!drag) return;
    view.offsetX += ev.clientX - drag.x;
    view.offsetY += ev.clientY - drag.y;
    drag = { x: ev.clientX, y: ev.clientY };
    schedule();
  };
  const onPointerUp = () => {
    drag = null;
    wrap.classList.remove("panning");
  };
  wrap.addEventListener("pointerdown", onPointerDown);
  wrap.addEventListener("pointermove", onPointerMove);
  wrap.addEventListener("pointerup", onPointerUp);
  wrap.addEventListener("pointercancel", onPointerUp);

  const onKey = (ev) => {
    if (ev.key === "0" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      fit();
    } else if ((ev.key === "=" || ev.key === "+") && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      zoomAt(1.2, ...centre());
    } else if (ev.key === "-" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      zoomAt(1 / 1.2, ...centre());
    }
  };
  wrap.tabIndex = 0;
  wrap.addEventListener("keydown", onKey);

  const ro = new ResizeObserver(() => schedule());
  ro.observe(wrap);

  host.appendChild(wrap);

  // --- images --------------------------------------------------------------
  // Decoded up front and cached: fetching inside the paint loop would restart
  // it on every frame, and an <img> that isn't loaded draws nothing.
  for (const element of scene.elements) {
    if (element.type !== "image") continue;
    const url = imageDataUrl(element, scene.files);
    if (!url || images.has(element.fileId)) continue;
    const img = new Image();
    img.src = url;
    img.decode().then(
      () => {
        if (disposed) return;
        images.set(element.fileId, img);
        schedule();
      },
      () => {}, // an undecodable embed draws as its placeholder box
    );
  }

  const skipped = scene.elements.filter((e) => !isDrawn(e)).length;
  const count = scene.elements.length;
  sceneNote = skipped
    ? `${count} elements · ${skipped} not renderable here`
    : `${count} elements`;

  if (!bounds) sceneNote = "This scene is empty.";
  publish();
  fit();

  return () => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    ro.disconnect();
    wrap.removeEventListener("wheel", onWheel);
    wrap.removeEventListener("pointerdown", onPointerDown);
    wrap.removeEventListener("pointermove", onPointerMove);
    wrap.removeEventListener("pointerup", onPointerUp);
    wrap.removeEventListener("pointercancel", onPointerUp);
    wrap.removeEventListener("keydown", onKey);
    // The decoded images are held only by this map and were never in the
    // document, so dropping it is the whole teardown — and their sources are
    // data: URLs, so there's no fetch left in flight to abort.
    images.clear();
  };
}

// --- element drawing --------------------------------------------------------

/// Draw one element. Exported so every branch can be driven headlessly in
/// ui/test/excalidrawDraw.test.js against a recording context — this file can't
/// otherwise be tested without a real canvas, and a typo in a rarely-hit shape
/// would only ever show up as a missing element in someone's diagram.
export function drawElement(ctx, rc, element, scene, images) {
  // Deleted elements stay in the file — Excalidraw keeps them for undo and for
  // merging another client's edits — and must not be drawn. `parseScene` strips
  // them on the read path, but the editor paints straight from the live
  // document, where a tombstone is a real element with `isDeleted: true`.
  if (element?.isDeleted) return;

  // Excalidraw's dark theme is a per-colour transform of the *same* file, not a
  // second palette, so the theme it was last viewed in is the theme its colours
  // have to be filtered for (shape.ts:222, :236).
  const isDarkMode = scene?.appState?.theme === "dark";

  ctx.save();
  ctx.globalAlpha = opacityOf(element);
  // renderElement.ts:330-331, :338-339. Canvas defaults to butt caps and mitre
  // joins, which leaves every one of Rough's multi-stroke passes square-ended:
  // small joins read as notches, and a gap up to strokeWidth/2 that round caps
  // would have closed on their own stays open.
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Rotation is about the element's own centre.
  const angle = typeof element.angle === "number" ? element.angle : 0;
  if (angle) {
    const cx = element.x + (element.width || 0) / 2;
    const cy = element.y + (element.height || 0) / 2;
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.translate(-cx, -cy);
  }

  switch (element.type) {
    case "rectangle": drawRectangle(rc, element, isDarkMode); break;
    case "diamond": drawDiamond(rc, element, isDarkMode); break;
    case "ellipse": drawEllipse(rc, element, isDarkMode); break;
    case "line":
    case "arrow": drawLinear(ctx, rc, element, isDarkMode); break;
    case "freedraw": drawFreedraw(ctx, element, isDarkMode); break;
    case "text": drawText(ctx, element, isDarkMode); break;
    case "image": drawImage(ctx, element, scene, images); break;
    case "frame": drawFrame(ctx, element); break;
    default: drawPlaceholder(ctx, element); break;
  }
  ctx.restore();
}

function drawRectangle(rc, element, isDarkMode) {
  const { x, y, width: w, height: h } = element;
  const r = cornerRadius(element);
  if (r <= 0) {
    // A sharp rectangle is one primitive, and Excalidraw lets its corners come
    // apart at Cartoonist too — shape.ts:797-810 passes continuousPath false.
    rc.rectangle(x, y, w, h, roughOptions(element, { isDarkMode }));
    return;
  }
  // Rough.js has no rounded rectangle, so it draws the path Excalidraw builds.
  //
  // A path() is rendered segment by segment, and without preserveVertices each
  // segment's endpoints wander independently — so at Cartoonist all eight
  // joints of a rounded box open up (measured 4.7-6.1px). Excalidraw passes
  // continuousPath true here for exactly that reason (shape.ts:786-795), and
  // measures 0.00px at every joint at every seed.
  rc.path(
    roundedRectPath(x, y, w, h, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2)),
    roughOptions(element, { continuousPath: true, isDarkMode }),
  );
}

const roundedRectPath = (x, y, w, h, r) =>
  `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y}, ${x + w} ${y + r} ` +
  `L ${x + w} ${y + h - r} Q ${x + w} ${y + h}, ${x + w - r} ${y + h} ` +
  `L ${x + r} ${y + h} Q ${x} ${y + h}, ${x} ${y + h - r} ` +
  `L ${x} ${y + r} Q ${x} ${y}, ${x + r} ${y}`;

function drawDiamond(rc, element, isDarkMode) {
  const { x, y, width: w, height: h } = element;
  // Excalidraw's getDiamondPoints order: top, right, bottom, left.
  const topX = x + w / 2, topY = y;
  const rightX = x + w, rightY = y + h / 2;
  const bottomX = x + w / 2, bottomY = y + h;
  const leftX = x, leftY = y + h / 2;

  if (!element.roundness) {
    rc.polygon(
      [[topX, topY], [rightX, rightY], [bottomX, bottomY], [leftX, leftY]],
      roughOptions(element, { isDarkMode }),
    );
    return;
  }
  // A rounded diamond has a different radius per axis, because its edges are
  // diagonal: the horizontal inset is measured along the top-to-left run and
  // the vertical one along the top-to-right rise (shape.ts:826-843). Same
  // continuousPath reasoning as the rounded rectangle (shape.ts:847).
  const verticalRadius = cornerRadiusFor(Math.abs(topX - leftX), element);
  const horizontalRadius = cornerRadiusFor(Math.abs(rightY - topY), element);
  rc.path(
    roundedDiamondPath(
      topX, topY, rightX, rightY, bottomX, bottomY, leftX, leftY,
      verticalRadius, horizontalRadius,
    ),
    roughOptions(element, { continuousPath: true, isDarkMode }),
  );
}

/// Ported from shape.ts:838-843. The corners are quadratic-shaped cubics whose
/// two control points are both the apex, which is how Excalidraw rounds a
/// diamond without computing tangents.
const roundedDiamondPath = (tx, ty, rx, ry, bx, by, lx, ly, vr, hr) =>
  `M ${tx + vr} ${ty + hr} L ${rx - vr} ${ry - hr}`
  + ` C ${rx} ${ry}, ${rx} ${ry}, ${rx - vr} ${ry + hr}`
  + ` L ${bx + vr} ${by - hr}`
  + ` C ${bx} ${by}, ${bx} ${by}, ${bx - vr} ${by - hr}`
  + ` L ${lx + vr} ${ly + hr}`
  + ` C ${lx} ${ly}, ${lx} ${ly}, ${lx + vr} ${ly - hr}`
  + ` L ${tx - vr} ${ty + hr}`
  + ` C ${tx} ${ty}, ${tx} ${ty}, ${tx + vr} ${ty + hr}`;

function drawEllipse(rc, element, isDarkMode) {
  const { x, y, width: w, height: h } = element;
  rc.ellipse(x + w / 2, y + h / 2, w, h, roughOptions(element, { isDarkMode }));
}

function drawLinear(ctx, rc, element, isDarkMode) {
  const pts = Array.isArray(element.points) ? element.points : [];
  if (pts.length < 2) return;
  const abs = pts.map((p) => [element.x + (p?.[0] ?? 0), element.y + (p?.[1] ?? 0)]);
  // Excalidraw passes continuousPath *false* for a line or arrow
  // (shape.ts:875) — the opposite of the rounded box. A line is one primitive,
  // so there are no segment joints to hold together, and forcing
  // preserveVertices would only stop Cartoonist from looking like Cartoonist.
  const opts = roughOptions(element, { isDarkMode });
  // Which primitive is a property of the element, not of how many points it
  // has: `roundness` set means a drawn curve, absent means straight segments
  // (shape.ts:901-913). A closed line with a fill becomes a polygon, which is
  // the only way its fill has an inside to land in.
  const drawn = element.roundness
    ? rc.curve(abs, opts)
    : opts.fill
      ? rc.polygon(abs, opts)
      : rc.linearPath(abs, opts);

  if (element.type === "arrow") {
    // Excalidraw generates arrowheads through Rough too, at roughness
    // min(1, roughness) and always solid-stroked (shape.ts:417-423). These are
    // plain canvas paths — crisper than upstream at Cartoonist, but the same
    // geometry, which is where the visible error was.
    ctx.strokeStyle = applyDarkModeFilter(element.strokeColor || "#1e1e1e", isDarkMode);
    ctx.lineWidth = element.strokeWidth || 1;
    if (element.endArrowhead !== null) {
      arrowhead(ctx, element, abs, drawn, "end", element.endArrowhead ?? "arrow");
    }
    if (element.startArrowhead) {
      arrowhead(ctx, element, abs, drawn, "start", element.startArrowhead);
    }
  }
}

/// How long an arrowhead is, in px (bounds.ts:712-731).
const arrowheadSize = (kind) => {
  if (kind === "arrow") return 25;
  if (kind === "diamond" || kind === "diamond_outline") return 12;
  return 15;
};

/// The half-spread between an arrowhead's two barbs, in radians
/// (bounds.ts:734-742). `bar` is 90°, which is what makes it a bar.
const arrowheadAngle = (kind) => {
  if (kind === "bar") return Math.PI / 2;
  if (kind === "arrow") return (20 * Math.PI) / 180;
  return (25 * Math.PI) / 180;
};

/// The ops of a Drawable's path set. Rough emits every shape as a `move`
/// followed by `bcurveTo`s, including a straight line — which is what makes the
/// tangent below available at all.
const curvePathOps = (drawable) =>
  drawable?.sets?.find((s) => s.type === "path")?.ops ?? [];

/// Rotate `p` about `about` by `angle`.
const rotateAbout = (p, about, angle) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p[0] - about[0];
  const dy = p[1] - about[1];
  return [about[0] + dx * c - dy * s, about[1] + dx * s + dy * c];
};

/// Where an arrowhead sits and which way it points, taken from the curve Rough
/// actually drew rather than from the element's own points (bounds.ts:762-809).
///
/// This is the difference that shows: on a curved arrow the last segment's chord
/// and the curve's tangent at its end are not the same direction, so a head
/// aimed along the chord visibly hangs off the line. Excalidraw evaluates the
/// rendered cubic at t = 0.3 and aims from there to the endpoint — and because
/// the endpoint is the *drawn* one, the head also sits on the sketched line
/// instead of floating at the ideal coordinate.
function arrowheadAim(drawable, position) {
  const ops = curvePathOps(drawable);
  const index = position === "start" ? 1 : ops.length - 1;
  const op = ops[index];
  if (!op || op.op !== "bcurveTo" || op.data?.length !== 6) return null;
  const p1 = [op.data[0], op.data[1]];
  const p2 = [op.data[2], op.data[3]];
  const p3 = [op.data[4], op.data[5]];
  // p0 is where the previous op left off: the start of a sub-path, or the end
  // of the curve before this one.
  const prev = ops[index - 1];
  let p0 = [0, 0];
  if (prev?.op === "move") p0 = [prev.data[0], prev.data[1]];
  else if (prev?.op === "bcurveTo") p0 = [prev.data[4], prev.data[5]];

  // B(t), with p3 and p0 in the places bounds.ts:786-790 puts them.
  const at = (t, i) =>
    (1 - t) ** 3 * p3[i] + 3 * t * (1 - t) ** 2 * p2[i]
    + 3 * t ** 2 * (1 - t) * p1[i] + p0[i] * t ** 3;
  const tip = position === "start" ? p0 : p3;
  const back = [at(0.3, 0), at(0.3, 1)];
  const d = Math.hypot(tip[0] - back[0], tip[1] - back[1]);
  if (!d) return null;
  return { tip, nx: (tip[0] - back[0]) / d, ny: (tip[1] - back[1]) / d };
}

/// Draw one arrowhead.
///
/// `abs` is the element's points in scene space and `drawable` is what Rough
/// returned for the line, because the size depends on the first and the aim on
/// the second.
function arrowhead(ctx, element, abs, drawable, position, kind) {
  const aim = arrowheadAim(drawable, position);
  if (!aim) return;
  const { tip, nx, ny } = aim;

  // Scaled down until it stops looking bigger than the arrow it is on: a head
  // is never more than half the last segment (a quarter, for a diamond, which
  // is twice as long as it is wide) — bounds.ts:820-834.
  const near = position === "end" ? abs[abs.length - 2] : abs[1];
  const lastSegment = Math.hypot(tip[0] - near[0], tip[1] - near[1]);
  const multiplier = kind === "diamond" || kind === "diamond_outline" ? 0.25 : 0.5;
  const size = Math.min(arrowheadSize(kind), lastSegment * multiplier);

  if (kind === "dot" || kind === "circle" || kind === "circle_outline") {
    // A filled disc whose diameter is the head's length, nudged by the stroke
    // so a thick arrow gets a proportionate dot (bounds.ts:842-845). "dot" is
    // the legacy spelling of "circle".
    const diameter = Math.max(0, size + (element.strokeWidth || 1) - 2);
    ctx.beginPath();
    ctx.arc(tip[0], tip[1], diameter / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    ctx.stroke();
    return;
  }

  // The two barbs: the point `size` back along the aim, rotated either way by
  // the head's angle (bounds.ts:865-875).
  const angle = arrowheadAngle(kind);
  const heel = [tip[0] - nx * size, tip[1] - ny * size];
  const a = rotateAbout(heel, tip, -angle);
  const b = rotateAbout(heel, tip, angle);

  if (kind === "diamond" || kind === "diamond_outline") {
    // The fourth point is the one opposite the tip, `size * 2` back along the
    // last segment's own direction rather than along the tangent
    // (bounds.ts:877-903).
    const near2 = position === "end" ? abs[abs.length - 2] : abs[1];
    const along = position === "end"
      ? Math.atan2(tip[1] - near2[1], tip[0] - near2[0])
      : Math.atan2(near2[1] - tip[1], near2[0] - tip[0]);
    const back = rotateAbout(
      [tip[0] + (position === "end" ? -size * 2 : size * 2), tip[1]], tip, along,
    );
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(a[0], a[1]);
    ctx.lineTo(back[0], back[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    ctx.stroke();
    return;
  }

  // `bar` lands here as well, and needs no special case: at 90° the two barbs
  // are perpendicular to the aim, so the same two strokes draw a crossbar.
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(tip[0], tip[1]);
  ctx.lineTo(b[0], b[1]);
  if (kind === "triangle" || kind === "triangle_outline") {
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }
  ctx.stroke();
}

function drawFreedraw(ctx, element, isDarkMode) {
  const pts = Array.isArray(element.points) ? element.points : [];
  if (!pts.length) return;
  // perfect-freehand is what Excalidraw draws pencil strokes with, so the
  // pressure profile comes out the same shape rather than a lookalike.
  //
  // The tuple width is not cosmetic. When `simulatePressure` is on, Excalidraw
  // hands getStroke bare 2-tuples and lets it invent the pressure from point
  // spacing; only when the device recorded real pressure does it pass 3-tuples
  // (shape.ts:1205-1211). Passing a third element either way makes getStroke
  // trust a number nobody measured.
  const pressures = Array.isArray(element.pressures) ? element.pressures : [];
  const simulate = element.simulatePressure !== false;
  const input = pts.map((p, i) => {
    const at = [element.x + (p?.[0] ?? 0), element.y + (p?.[1] ?? 0)];
    return simulate ? at : [...at, pressures[i] ?? 0.5];
  });
  const outline = getStroke(input, {
    size: (element.strokeWidth || 1) * 4.25,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    // easeOutSine (shape.ts:1219). Without it the taper runs on a straight
    // ramp, so a stroke's tip thins on the wrong curve.
    easing: (t) => Math.sin((t * Math.PI) / 2),
    simulatePressure: simulate,
    last: true,
  });
  if (outline.length < 2) return;
  // Excalidraw closes the outline with quadratics through the midpoints of
  // consecutive points rather than straight segments (getSvgPathFromStroke,
  // utils.ts:1005-1036) — the same points, but the edges stop being faceted.
  ctx.beginPath();
  strokeOutlinePath(ctx, outline);
  // A freehand stroke is a filled outline, not a stroked path — that's how it
  // gets its variable width.
  ctx.fillStyle = applyDarkModeFilter(element.strokeColor || "#1e1e1e", isDarkMode);
  ctx.fill();
}

/// getSvgPathFromStroke (utils.ts:1005-1036) in canvas calls.
///
/// The path it builds is `M p0 Q p1 mid(p1,p2) T mid(p2,p3) mid(p3,p4) …`, and
/// the `T` matters: a smooth quadratic takes its control point as the
/// reflection of the previous one about the current point, which is what makes
/// the outline continuous rather than a chain of independent arcs. Canvas has no
/// `T`, so the reflection is computed here — `2p − c`, straight from the SVG
/// path spec.
function strokeOutlinePath(ctx, points) {
  if (points.length < 4) {
    // Upstream returns an empty path here and draws nothing. A polyline is the
    // honest fallback and keeps a stroke that is barely a dot visible.
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    return;
  }
  const mid = (a, b) => (a + b) / 2;
  ctx.moveTo(points[0][0], points[0][1]);
  // Control point, then current point, carried through the loop.
  let cx = points[1][0];
  let cy = points[1][1];
  let px = mid(points[1][0], points[2][0]);
  let py = mid(points[1][1], points[2][1]);
  ctx.quadraticCurveTo(cx, cy, px, py);
  for (let i = 2, max = points.length - 1; i < max; i++) {
    const nx = mid(points[i][0], points[i + 1][0]);
    const ny = mid(points[i][1], points[i + 1][1]);
    const rx = 2 * px - cx;
    const ry = 2 * py - cy;
    ctx.quadraticCurveTo(rx, ry, nx, ny);
    cx = rx; cy = ry; px = nx; py = ny;
  }
  ctx.closePath();
}

function drawText(ctx, element, isDarkMode) {
  const { align, lines } = textLayout(element);
  ctx.font = fontString(element);
  ctx.fillStyle = applyDarkModeFilter(element.strokeColor || "#1e1e1e", isDarkMode);
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  for (const line of lines) if (line.text) ctx.fillText(line.text, line.x, line.y);
}

function drawImage(ctx, element, scene, images) {
  const img = images.get(element.fileId);
  if (!img) {
    drawPlaceholder(ctx, element, "image");
    return;
  }
  ctx.drawImage(img, element.x, element.y, element.width, element.height);
}

function drawFrame(ctx, element) {
  ctx.strokeStyle = "hsl(0, 0%, 60%)";
  ctx.lineWidth = 2;
  ctx.strokeRect(element.x, element.y, element.width, element.height);
  if (element.name) {
    ctx.fillStyle = "hsl(0, 0%, 45%)";
    ctx.font = "14px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(element.name, element.x, element.y - 6);
  }
}

/// What an element we can't draw looks like: a dashed box saying what it was,
/// so a missing embed reads as "not shown here" rather than as a hole.
function drawPlaceholder(ctx, element, label = element.type) {
  const w = element.width || 120;
  const h = element.height || 60;
  ctx.strokeStyle = "hsl(0, 0%, 65%)";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1;
  ctx.strokeRect(element.x, element.y, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = "hsl(0, 0%, 50%)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(label ?? "element"), element.x + w / 2, element.y + h / 2);
}

// --- editor chrome ----------------------------------------------------------
//
// Everything below draws the editor's own furniture rather than the document:
// what is selected, what can be grabbed, what a drag is currently sweeping,
// and what it is about to snap to. None of it is in the file, none of it is in
// the model, and none of it survives a save.
//
// The shared rule is the one the header states: chrome is measured in screen
// pixels. Every one of these runs inside the same `ctx.scale(view.scale, ...)`
// the elements were drawn in, so a size that should stay put on screen is
// divided by `scale` on its way into scene space. That is the only arithmetic
// in this section, and it is why `{ scale }` is not optional in spirit even
// though it defaults to 1 — a caller that forgets it gets chrome that is
// correct at 100% zoom and wrong everywhere else, which is the hardest kind of
// wrong to notice.
//
// Bounds are the `{ minX, minY, maxX, maxY }` boxes excalidrawScene.js already
// speaks (and that xd-core will speak after Phase 2), so nothing has to
// translate between two shapes of rectangle.

/// The side of a resize handle, in screen pixels. Excalidraw's is 8; matching
/// it means a hand that has used Excalidraw already knows the target size.
export const HANDLE_SIZE = 8;

/// How far above the selection's top edge the rotate handle floats, in screen
/// pixels. Far enough to clear the north handle by more than a finger's width
/// of slop, or the two become one ambiguous target.
export const ROTATE_OFFSET = 20;

/// The eight resize handles, in the order Excalidraw names them, and the
/// rotate handle last. Exported because the tool state machine wants to talk
/// about handles by name and there should be exactly one list of the names.
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/// The same nine, in the order `geometry::Handle` discriminates its variants —
/// which is also the order `doc.handlePoints()` returns them in. Exported so a
/// caller passing `points` can be sure it means the same order this does.
export const HANDLES_WITH_ROTATE = [...HANDLES, "rotate"];

/// Put the names back on a bare list of positions.
///
/// `doc.handlePoints()` returns `[{ x, y }]` and nothing else, but `only` and
/// the rotate stalk both key off the name — so the zip happens here, once,
/// rather than at every call site that would otherwise have to know the order.
/// A list that already carries names passes through untouched.
const namedHandles = (points) =>
  (Array.isArray(points) ? points : []).map((p, i) => ({
    name: p?.name ?? HANDLES_WITH_ROTATE[i],
    x: p?.x,
    y: p?.y,
  }));

/// Chrome colours, resolved from CSS custom properties.
///
/// Read once at mount and passed back in, never per frame: getComputedStyle
/// forces style resolution, and this would run inside the paint loop of a
/// drag. The fallbacks are Excalidraw's own selection violet and a warm guide
/// red, so a host that defines none of these tokens still gets chrome that
/// looks deliberate rather than black-on-black.
///
/// This is the whole of Phase 5's "themes for free" promise: term.hut's panes
/// already define --accent and --border, so the view arrives themed without
/// anything being ported alongside it.
export function chromeTheme(node) {
  const fallback = {
    accent: "#6965db",
    guide: "#ff6b6b",
    handleFill: "#ffffff",
    marquee: "rgba(105, 101, 219, 0.12)",
  };
  if (typeof window === "undefined" || !node?.ownerDocument?.defaultView) return fallback;
  const css = node.ownerDocument.defaultView.getComputedStyle(node);
  const read = (name, or_) => {
    const v = css.getPropertyValue(name).trim();
    return v || or_;
  };
  return {
    accent: read("--xd-accent", read("--accent", fallback.accent)),
    guide: read("--xd-guide", read("--red", fallback.guide)),
    handleFill: read("--xd-handle-fill", read("--bg", fallback.handleFill)),
    marquee: read("--xd-marquee", fallback.marquee),
  };
}

/// Run `fn` with the canvas rotated about `bounds`' centre by `angle`.
///
/// A rotated element's selection box is rotated too — Excalidraw draws the
/// element's own axis-aligned box and turns it, rather than the upright box
/// that contains the turned shape, because the second one is not a box you can
/// resize along. Multi-selection has no angle of its own and passes 0.
function inFrame(ctx, bounds, angle, fn) {
  if (!angle) {
    fn();
    return;
  }
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.translate(-cx, -cy);
  fn();
}

/// Outline a selection.
///
/// `bounds` is one box or an array of them. An array is what multi-select
/// looks like: every member gets a thin outline of its own so it is obvious
/// *which* things are selected, and the caller then draws the union box with
/// handles on it. Passing the union alone would leave the user guessing
/// whether the shape under the box is in the set.
///
/// `padding` is in screen pixels — the outline sits just outside the shape so
/// it doesn't overprint a stroke of the same colour.
export function drawSelectionOutline(ctx, bounds, opts = {}) {
  const list = Array.isArray(bounds) ? bounds : [bounds];
  const {
    scale = 1, angle = 0, padding = 4, dashed = false,
    colors = null, lineWidth = 1,
  } = opts;
  const accent = colors?.accent ?? "#6965db";
  const pad = padding / scale;
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = lineWidth / scale;
  // Dashes are specified on screen too, or the pattern turns into a solid
  // line the moment you zoom out far enough.
  if (dashed) ctx.setLineDash([4 / scale, 4 / scale]);
  for (const b of list) {
    if (!b) continue;
    inFrame(ctx, b, angle, () => {
      ctx.strokeRect(
        b.minX - pad, b.minY - pad,
        (b.maxX - b.minX) + pad * 2, (b.maxY - b.minY) + pad * 2,
      );
    });
  }
  ctx.restore();
}

/// Where each handle sits, in scene coordinates, given a selection box.
///
/// Returned rather than drawn so the same list can label a cursor or a
/// tooltip. It is emphatically *not* a hit-test: the tool state machine asks
/// xd-core what the pointer is over, and a handle drawn somewhere xd-core
/// doesn't agree with is this file's bug to fix. The two are kept honest by
/// both deriving from the same bounds.
export function handlePositions(bounds, { scale = 1, padding = 4 } = {}) {
  if (!bounds) return [];
  const pad = padding / scale;
  const x0 = bounds.minX - pad;
  const y0 = bounds.minY - pad;
  const x1 = bounds.maxX + pad;
  const y1 = bounds.maxY + pad;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  return [
    { name: "nw", x: x0, y: y0 },
    { name: "n", x: mx, y: y0 },
    { name: "ne", x: x1, y: y0 },
    { name: "e", x: x1, y: my },
    { name: "se", x: x1, y: y1 },
    { name: "s", x: mx, y: y1 },
    { name: "sw", x: x0, y: y1 },
    { name: "w", x: x0, y: my },
    { name: "rotate", x: mx, y: y0 - ROTATE_OFFSET / scale },
  ];
}

/// Draw the eight resize handles and the rotate handle on a selection box.
///
/// Filled with the background token and stroked with the accent, which is how
/// a handle stays visible over both a dark shape and a light one — a solid
/// accent square vanishes against an accent-coloured stroke.
///
/// `only` narrows the set: a line has no meaningful corner handles, and a
/// multi-selection hides the rotate handle in Excalidraw. Passing a list is
/// cheaper than every caller filtering the return of handlePositions.
///
/// `points` overrides where the handles go, and exists so the model can answer
/// instead of this file. `doc.handlePoints(scenePerPx)` is the same nine
/// positions computed by the code that also hit-tests them, and until something
/// passes them in, the two agree only because `geometry.rs` and
/// `handlePositions` both hard-code the same 20px rotate offset — which is a
/// coincidence maintained by hand, not an invariant. A handle drawn where
/// xd-core does not agree it is is this file's bug (see the section header), so
/// the fix is to stop having a second opinion.
export function drawHandles(ctx, bounds, opts = {}) {
  if (!bounds) return;
  const { scale = 1, angle = 0, colors = null, only = null } = opts;
  const accent = colors?.accent ?? "#6965db";
  const fill = colors?.handleFill ?? "#ffffff";
  const size = HANDLE_SIZE / scale;
  const half = size / 2;
  const points = opts.points
    ? namedHandles(opts.points)
    : handlePositions(bounds, { scale, padding: opts.padding ?? 4 });
  ctx.save();
  inFrame(ctx, bounds, angle, () => {
    ctx.strokeStyle = accent;
    ctx.fillStyle = fill;
    ctx.lineWidth = 1 / scale;
    // The stalk first, so the handle's fill covers where it meets the box
    // rather than the line drawing over the handle.
    const rotate = points.find((p) => p.name === "rotate");
    const north = points.find((p) => p.name === "n");
    if (rotate && north && (!only || only.includes("rotate"))) {
      ctx.beginPath();
      ctx.moveTo(north.x, north.y);
      ctx.lineTo(rotate.x, rotate.y);
      ctx.stroke();
    }
    for (const p of points) {
      if (only && !only.includes(p.name)) continue;
      ctx.beginPath();
      // The rotate handle is a circle and the resize handles are squares, so
      // the two are told apart by shape and not only by position — which
      // matters at the top edge, where they are a few pixels apart.
      if (p.name === "rotate") ctx.arc(p.x, p.y, half, 0, Math.PI * 2);
      else ctx.rect(p.x - half, p.y - half, size, size);
      ctx.fill();
      ctx.stroke();
    }
  });
  ctx.restore();
}

/// Circles at a linear element's own points — the handles that let an endpoint
/// be picked up, which a bounding box cannot express.
///
/// A sibling of `drawHandles` rather than a mode of it, and deliberately so:
/// `drawHandles` names its nine positions in `HANDLES_WITH_ROTATE` order
/// because that is what `only` and the rotate stalk key off, where a line has
/// as many points as it likes and none of them has a name. The two share the
/// screen-pixel rule and nothing else.
///
/// `points` is `[{ x, y }]` in scene coordinates, which is what
/// `doc.pointHandles()` and `doc.midpointHandles()` return through the facade.
/// They are absolute — a rotated element's points are already turned — so
/// unlike the box chrome there is no angle to put the canvas into.
///
/// `filled` and `size` are what tell the two kinds apart: a point that exists
/// is solid, and a midpoint, where a click *makes* a point rather than moving
/// one, is drawn hollow and smaller.
export function drawPointHandles(ctx, points, opts = {}) {
  if (!points?.length) return;
  const { scale = 1, colors = null, filled = true, size = HANDLE_SIZE } = opts;
  const r = size / 2 / scale;
  ctx.save();
  ctx.strokeStyle = colors?.accent ?? "#6965db";
  ctx.fillStyle = colors?.handleFill ?? "#ffffff";
  ctx.lineWidth = 1 / scale;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    if (filled) ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/// The rubber-band rectangle a marquee drag is sweeping.
///
/// Filled as well as stroked: an outline alone over a busy diagram is hard to
/// see, and the wash is what makes "everything in here" read at a glance. The
/// fill is deliberately weak — it must not hide what it is about to select.
///
/// `rect` is a bounds box; a drag that went up and to the left produces one
/// with min > max, so it is normalised here rather than at every call site.
export function drawMarquee(ctx, rect, { scale = 1, colors = null } = {}) {
  if (!rect) return;
  const x = Math.min(rect.minX, rect.maxX);
  const y = Math.min(rect.minY, rect.maxY);
  const w = Math.abs(rect.maxX - rect.minX);
  const h = Math.abs(rect.maxY - rect.minY);
  ctx.save();
  ctx.fillStyle = colors?.marquee ?? "rgba(105, 101, 219, 0.12)";
  ctx.strokeStyle = colors?.accent ?? "#6965db";
  ctx.lineWidth = 1 / scale;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/// Alignment guides: the lines that say "this edge is level with that one".
///
/// `guides` is a list of `{ x1, y1, x2, y2 }` segments in scene coordinates,
/// computed by whoever knows the geometry — this draws them and holds no
/// opinion about where they came from.
///
/// Drawn thin, dashed, in the guide colour, with a tick at each end. The ticks
/// are what distinguish a guide from a line someone drew: a guide has visible
/// stops, and it appears and disappears as you drag.
export function drawSnapGuides(ctx, guides, { scale = 1, colors = null } = {}) {
  const list = Array.isArray(guides) ? guides : [];
  if (!list.length) return;
  const guide = colors?.guide ?? "#ff6b6b";
  const tick = 4 / scale;
  ctx.save();
  ctx.strokeStyle = guide;
  ctx.lineWidth = 1 / scale;
  ctx.setLineDash([4 / scale, 3 / scale]);
  for (const g of list) {
    if (!g) continue;
    ctx.beginPath();
    ctx.moveTo(g.x1, g.y1);
    ctx.lineTo(g.x2, g.y2);
    ctx.stroke();
  }
  // Ticks are solid — a dashed 8-pixel cross reads as nothing at all.
  ctx.setLineDash([]);
  for (const g of list) {
    if (!g) continue;
    // Perpendicular to the guide, so a horizontal guide gets vertical ticks.
    const dx = g.x2 - g.x1;
    const dy = g.y2 - g.y1;
    const len = Math.hypot(dx, dy) || 1;
    const px = (-dy / len) * tick;
    const py = (dx / len) * tick;
    for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2]]) {
      ctx.beginPath();
      ctx.moveTo(x - px, y - py);
      ctx.lineTo(x + px, y + py);
      ctx.stroke();
    }
  }
  ctx.restore();
}
