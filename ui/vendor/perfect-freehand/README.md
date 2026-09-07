# Vendored perfect-freehand

`perfect-freehand.esm.js` is perfect-freehand 1.2.3's ESM build
(`dist/esm/index.mjs` from the npm tarball, with its `sourceMappingURL` comment
stripped since the `.map` isn't vendored). MIT — see `LICENSE`.

4.5 KB, zero dependencies, zero bare imports. Used by the `.excalidraw` canvas
view (`ui/src/excalidrawView.js`) to draw `freedraw` elements.

It's the same library Excalidraw draws pencil strokes with, so a stroke's
pressure profile comes out the right shape rather than a lookalike. `getStroke`
returns an *outline* polygon — a freehand stroke is filled, not stroked, which
is how it gets its variable width.

## To update

```sh
curl -sL $(curl -s https://registry.npmjs.org/perfect-freehand/latest \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['dist']['tarball'])") \
  | tar xz -O package/dist/esm/index.mjs > perfect-freehand.esm.js
sed -i '' 's|//# sourceMappingURL=.*||' perfect-freehand.esm.js
```

Then bump the version above.
