// Color swatches + picker for the editor pane. parseColor/formatColor
// round-trip hex (#rgb/#rgba/#rrggbb/#rrggbbaa), rgb()/rgba() and
// hsl()/hsla() — classic comma syntax and modern space syntax both — and
// openColorPicker() drives a hand-rolled SV-square + hue + alpha popover
// (styled by .color-picker in index.html). No dependency, per the app's
// no-build vendor philosophy. editor.js owns detection-in-the-document and
// writing picks back into the buffer.

// One regex both the decoration pass and the click-time re-match use, so they
// can never disagree about what counts as a color. The lookbehind keeps hex
// out of identifiers/entities (`&#123;`, `id#fff`); parseColor is the real
// validator — anything this matches that doesn't parse gets no swatch.
export const COLOR_RE =
  /(?<![-\w&$#])(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w#])|(?:rgba?|hsla?)\(\s*[-\d.,%\sdeg/]+\))/gi;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Parse to { r, g, b (0-255), a (0-1), kind: "hex"|"rgb"|"hsl", space: bool }
// or null. `space` remembers modern space syntax so edits keep the file's style.
export function parseColor(str) {
  str = str.trim();
  if (str[0] === "#") {
    const hex = str.slice(1);
    if (!/^[0-9a-fA-F]{3,8}$/.test(hex) || hex.length === 5 || hex.length === 7) return null;
    const short = hex.length <= 4;
    const chan = (i) => short
      ? parseInt(hex[i] + hex[i], 16)
      : parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const hasA = hex.length === 4 || hex.length === 8;
    return { r: chan(0), g: chan(1), b: chan(2), a: hasA ? chan(3) / 255 : 1, kind: "hex", space: false };
  }
  const m = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(str);
  if (!m) return null;
  const kind = m[1].toLowerCase().startsWith("rgb") ? "rgb" : "hsl";
  const body = m[2].trim();
  const space = !body.includes(",");
  const tokens = body.replace("/", " ").split(/[\s,]+/).filter(Boolean);
  if (tokens.length !== 3 && tokens.length !== 4) return null;
  // Channel value honoring an optional % suffix (scaled to `max`).
  const num = (tok, max) => {
    const pct = tok.endsWith("%");
    const n = parseFloat(tok);
    return pct ? (n / 100) * max : n;
  };
  const a = tokens.length === 4 ? clamp(num(tokens[3], 1), 0, 1) : 1;
  if (Number.isNaN(a)) return null;
  let r, g, b;
  if (kind === "rgb") {
    [r, g, b] = tokens.slice(0, 3).map((tok) => num(tok, 255));
  } else {
    const h = parseFloat(tokens[0].replace(/deg$/i, ""));
    const s = num(tokens[1], 1), l = num(tokens[2], 1);
    if ([h, s, l].some(Number.isNaN)) return null;
    [r, g, b] = hslToRgb(((h % 360) + 360) % 360, clamp(s, 0, 1), clamp(l, 0, 1));
  }
  if ([r, g, b].some(Number.isNaN)) return null;
  return { r: clamp(Math.round(r), 0, 255), g: clamp(Math.round(g), 0, 255), b: clamp(Math.round(b), 0, 255), a, kind, space };
}

// --- Color space conversions (r/g/b 0-255; h 0-360; s/l/v 0-1) ---

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = !d ? 0
    : max === r ? (((g - b) / d + 6) % 6) * 60
    : max === g ? ((b - r) / d + 2) * 60
    : ((r - g) / d + 4) * 60;
  return [h, max ? d / max : 0, max];
}

export function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [f(5), f(3), f(1)];
}

// --- Formatting ---

// 0.50 → "0.5"; keeps two significant decimals without trailing zeros.
const fmtAlpha = (a) => String(+a.toFixed(2));
const hex2 = (n) => Math.round(n).toString(16).padStart(2, "0");

export function formatColor(r, g, b, a, kind, space) {
  r = Math.round(r); g = Math.round(g); b = Math.round(b);
  if (kind === "hex") return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ""}`;
  if (kind === "rgb") {
    if (space) return `rgb(${r} ${g} ${b}${a < 1 ? ` / ${fmtAlpha(a)}` : ""})`;
    return a < 1 ? `rgba(${r}, ${g}, ${b}, ${fmtAlpha(a)})` : `rgb(${r}, ${g}, ${b})`;
  }
  let [h, s, l] = rgbToHsl(r, g, b);
  h = Math.round(h); s = Math.round(s * 100); l = Math.round(l * 100);
  if (space) return `hsl(${h} ${s}% ${l}%${a < 1 ? ` / ${fmtAlpha(a)}` : ""})`;
  return a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${fmtAlpha(a)})` : `hsl(${h}, ${s}%, ${l}%)`;
}

// --- Picker popover ---

let openEl = null, teardown = null;

export function closeColorPicker() {
  teardown?.();
  openEl?.remove();
  openEl = null;
  teardown = null;
}

// Open the picker next to `anchor` (a DOMRect), initialized from the color
// text `color`. Every adjustment calls onChange(newText) — the caller writes
// it into the document. Clicking the value line cycles hex → rgb → hsl.
export function openColorPicker({ anchor, color, onChange, onClose }) {
  closeColorPicker();
  const parsed = parseColor(color) ?? { r: 255, g: 255, b: 255, a: 1, kind: "hex", space: false };
  let { kind, space } = parsed;
  // HSV is the picker's authoritative state: reparsing our own output would
  // collapse hue/saturation at black, white and greys.
  let [h, s, v] = rgbToHsv(parsed.r, parsed.g, parsed.b);
  let a = parsed.a;

  const pop = document.createElement("div");
  pop.className = "color-picker";
  // Static skeleton, nothing interpolated.
  pop.innerHTML = `
    <div class="cp-sv"><div class="cp-thumb"></div></div>
    <div class="cp-slider cp-hue"><div class="cp-thumb"></div></div>
    <div class="cp-slider cp-alpha"><div class="cp-fill"></div><div class="cp-thumb"></div></div>
    <div class="cp-out">
      <span class="cp-chip"><span class="cp-chip-fill"></span></span>
      <span class="cp-value" title="Click to switch format (hex → rgb → hsl)"></span>
    </div>`;
  const [sv, hue, alpha] = pop.querySelectorAll(".cp-sv, .cp-slider");
  const [svThumb, hueThumb, alphaThumb] = pop.querySelectorAll(".cp-thumb");
  const alphaFill = pop.querySelector(".cp-fill");
  const chipFill = pop.querySelector(".cp-chip-fill");
  const valueEl = pop.querySelector(".cp-value");

  const current = () => {
    const [r, g, b] = hsvToRgb(h, s, v);
    return [Math.round(r), Math.round(g), Math.round(b)];
  };

  function paint() {
    const [r, g, b] = current();
    sv.style.background =
      `linear-gradient(to top, hsl(0, 0%, 0%), transparent), linear-gradient(to right, hsl(0, 0%, 100%), hsl(${Math.round(h)}, 100%, 50%))`;
    svThumb.style.left = `${s * 100}%`;
    svThumb.style.top = `${(1 - v) * 100}%`;
    svThumb.style.background = `rgb(${r}, ${g}, ${b})`;
    hueThumb.style.left = `${(h / 360) * 100}%`;
    hueThumb.style.background = `hsl(${Math.round(h)}, 100%, 50%)`;
    alphaFill.style.background = `linear-gradient(to right, transparent, rgb(${r}, ${g}, ${b}))`;
    alphaThumb.style.left = `${a * 100}%`;
    chipFill.style.background = `rgba(${r}, ${g}, ${b}, ${a})`;
    valueEl.textContent = formatColor(r, g, b, a, kind, space);
  }

  function emit() {
    const [r, g, b] = current();
    onChange(formatColor(r, g, b, a, kind, space));
  }

  // Normalized drag on a pad/slider: fn(x, y) with both in [0, 1], called on
  // press and on every captured move.
  function bindDrag(el, fn) {
    el.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      el.setPointerCapture(ev.pointerId);
      const move = (e) => {
        const r = el.getBoundingClientRect();
        fn(clamp((e.clientX - r.left) / r.width, 0, 1),
           clamp((e.clientY - r.top) / r.height, 0, 1));
        paint();
        emit();
      };
      move(ev);
      const done = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", done);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", done);
    });
  }

  bindDrag(sv, (x, y) => { s = x; v = 1 - y; });
  bindDrag(hue, (x) => { h = Math.min(x * 360, 359.9); });
  bindDrag(alpha, (x) => { a = x; });

  valueEl.addEventListener("click", () => {
    kind = kind === "hex" ? "rgb" : kind === "rgb" ? "hsl" : "hex";
    paint();
    emit();
  });
  // Keep clicks inside the popover from reaching the window-level dismissers
  // (ours below, and menu.js's closeMenu).
  pop.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  pop.addEventListener("click", (ev) => ev.stopPropagation());

  paint();
  pop.style.visibility = "hidden";
  document.body.appendChild(pop);
  // Below the swatch, flipped above when there's no room, clamped to viewport.
  const r = pop.getBoundingClientRect();
  const left = clamp(anchor.left - 8, 6, window.innerWidth - r.width - 6);
  let top = anchor.bottom + 6;
  if (top + r.height > window.innerHeight - 6) top = Math.max(6, anchor.top - r.height - 6);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.visibility = "";

  const onDown = (ev) => { if (!pop.contains(ev.target)) closeColorPicker(); };
  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    closeColorPicker();
  };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeColorPicker);

  openEl = pop;
  teardown = () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", closeColorPicker);
    onClose?.();
  };
}
