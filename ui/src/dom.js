// Tiny shared DOM helpers. All text lands via textContent, never innerHTML.

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function div(cls, text) {
  return el("div", cls, text);
}

export function mkBtn(label, cls, onClick) {
  const b = el("button", cls, label);
  b.addEventListener("click", onClick);
  return b;
}

// Inline checkmark icon (safe static markup, set via innerHTML).
export const CHECK_SVG =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none">' +
  '<path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

/// Shorten a home-rooted path for display ("/Users/x/repos/y" → "~/repos/y").
export function tildify(p) {
  return p ? p.replace(/^\/Users\/[^/]+/, "~") : "";
}

/// Coarse relative-time label ("now", "5m ago", "2h ago", "3d ago") from an
/// age in seconds.
export function timeAgo(seconds) {
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
