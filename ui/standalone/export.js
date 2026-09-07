// Export: the save-dialog half, and only the save-dialog half.
//
// Read this before adding anything to this file.
//
// PNG and SVG export is *two* things, and the plan puts them on opposite sides
// of the line on purpose (PLAN.md Phase 7, and the risk list at the bottom of
// the plan names this file's temptation by name):
//
//   The capability — turn the current scene into pixels or into SVG — belongs
//   to the portable view. It is the painter's own geometry drawn to a second
//   surface, it needs the live scene and the current selection, and when
//   term.hut takes the view it inherits export for free. That code goes in
//   excalidrawEdit.js and is offered through `onActions` like every other
//   thing the view can do.
//
//   The dialog — ask the user where to put the bytes, then put them there —
//   belongs here. It is a filesystem and a native dialog, neither of which a
//   view embedded in someone else's app is allowed to know about.
//
// The pull toward doing all of it here is strong and specific: the view does
// not exist yet, this file does, and `canvas.toBlob` is four lines. Four lines
// that would then have to be found again and moved at the port, at the exact
// moment when the temptation is to widen the allowlist instead. So this module
// asks the view for the bytes and says "not yet" when the view has no answer.
// That is the intended state until Phase 6 lands the capability, not a stub
// someone forgot to finish.

import { chooseSavePath, writeFile, isApp } from "./files.js";

/// Swap `.excalidraw` for the export's own extension, so "diagram.excalidraw"
/// suggests "diagram.png" rather than "diagram.excalidraw.png".
const suggestName = (docPath, ext) => {
  const base = (docPath || "Untitled").split("/").pop() || "Untitled";
  return `${base.replace(/\.(excalidraw|json)$/i, "")}.${ext}`;
};

/// Export the mounted view to SVG.
///
/// `getView()` returns whatever the current mount handed back — today a bare
/// dispose function with no capabilities on it at all, later the editor's
/// handle. `view.exportSVG()` is the contract: it returns the document's SVG
/// as a string, or throws with a sentence worth showing.
///
/// Text goes through `xd_write_file` unchanged, which is the whole reason SVG
/// is the easier of the two.
export async function exportSvg({ getView, docPath, report }) {
  const view = getView?.();
  if (typeof view?.exportSVG !== "function") {
    report?.("SVG export isn't built yet — it lands with the editor.");
    return;
  }
  if (!isApp()) {
    report?.("Export needs the app; a browser tab has nowhere to put the file.");
    return;
  }
  let svg;
  try {
    svg = await view.exportSVG();
  } catch (e) {
    report?.(`Couldn't render the SVG: ${e?.message ?? e}`);
    return;
  }
  // Asked *after* the render succeeds: a dialog that opens and then reports a
  // failure has wasted a decision the user already made.
  const path = await chooseSavePath(suggestName(docPath, "svg"));
  if (!path) return; // cancelled, which is not a failure
  try {
    await writeFile(path, String(svg));
    report?.("");
  } catch (e) {
    report?.(`Couldn't write the SVG: ${e?.message ?? e}`);
  }
}

/// Export the mounted view to PNG.
///
/// Blocked on a second thing, and it is worth being explicit about which:
/// `xd_write_file` takes a `String`, and a PNG is bytes. Writing them through
/// a text command would corrupt every non-UTF-8 byte in the file, which is
/// most of them. So this path needs a bytes-capable command on the Rust side
/// — `xd_write_bytes(path, contents: Vec<u8>)` is the obvious shape — and
/// until that exists there is nothing to wire the dialog to.
///
/// Reported rather than silently missing: an export menu entry that does
/// nothing is worse than one that says why.
export async function exportPng({ getView, docPath, report }) {
  const view = getView?.();
  if (typeof view?.exportPNG !== "function") {
    report?.("PNG export isn't built yet — it lands with the editor.");
    return;
  }
  if (!isApp()) {
    report?.("Export needs the app; a browser tab has nowhere to put the file.");
    return;
  }
  let bytes;
  try {
    bytes = await view.exportPNG();
  } catch (e) {
    report?.(`Couldn't render the PNG: ${e?.message ?? e}`);
    return;
  }
  const path = await chooseSavePath(suggestName(docPath, "png"));
  if (!path) return;
  void bytes;
  void path;
  report?.("PNG export needs a bytes-capable write command (xd_write_bytes).");
}

/// The export entries for the app's header, in `viewActions.js`'s descriptor
/// shape. Contributed by the shell alongside the view's own actions rather
/// than by the view, because these two are the dialog half — the view will
/// contribute its own Export entries when it grows the capability, and the two
/// sets have different ids so neither displaces the other.
export function exportActions({ getView, docPath, report }) {
  return [
    {
      id: "app-export-png",
      label: "PNG",
      title: "Export this drawing as a PNG",
      run: () => exportPng({ getView, docPath: docPath(), report }),
    },
    {
      id: "app-export-svg",
      label: "SVG",
      title: "Export this drawing as an SVG",
      run: () => exportSvg({ getView, docPath: docPath(), report }),
    },
  ];
}
