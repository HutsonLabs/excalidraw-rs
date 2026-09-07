# Vendored Rough.js

`rough.esm.js` is Rough.js 4.6.6's **pre-bundled ESM build** (`bundled/rough.esm.js`
from the npm tarball), used by the `.excalidraw` canvas view
(`ui/src/excalidrawView.js`). MIT — see `LICENSE`.

Take the `bundled/` build, not `dist/`: `bundled/` has Rough's four dependencies
(`hachure-fill`, `points-on-path`, `points-on-curve`, `path-data-parser`)
inlined, so it is a single self-contained file with **zero bare imports** and
drops straight into a frontend with no bundler — the same deal as
`ui/vendor/xterm`. `dist/` does not; it would need a resolver.

## Why this rather than Excalidraw

An `.excalidraw` file is JSON, and the hand-drawn look isn't Excalidraw's — it's
Rough.js, with perfect-freehand for pencil strokes. Rendering the format needs
those two (32 KB together, both framework-free). `@excalidraw/excalidraw` is a
React application: it would have meant React + ReactDOM, ~19 unbundled bare
specifiers to resolve, a build step this frontend doesn't have, and ~3.9 MB.

Each element in a scene carries a `seed`, and Rough.js is deterministic for a
given seed — which is what makes this a port rather than an approximation: a
file draws the same on every open, and the same as it does in Excalidraw.

## To update

No npm install needed — stream the file out of the registry:

```sh
curl -sL $(curl -s https://registry.npmjs.org/roughjs/latest \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['dist']['tarball'])") \
  | tar xz -O package/bundled/rough.esm.js > rough.esm.js
```

Then bump the version above, and re-run `bun test ui/test/excalidrawScene.test.js` —
it drives Rough's generator directly, so an option the port relies on
disappearing shows up there rather than as a blank shape in a diagram.
