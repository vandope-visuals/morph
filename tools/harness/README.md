# harness

Playwright smoke test, per-effect benchmark and visual diff for `index.html`.

```
npm ci
node run.mjs                 # smoke + bench + shots, compares to baseline/
node run.mjs --only smoke    # fast correctness pass
```

- **smoke**: loads every source type (image/video fixtures, fake webcam), every effect × 8 modes, every modulator, a 5-module chain, the output window, theme/CRT toggles. Fails on any console error or page error.
- **bench**: ms/frame from calling `renderFrame()` synchronously (rAF stubbed, GPU flushed with a 1px readback), governor pinned at 854×480. `fx:*` values are the delta over an image-only frame; `fx:keyer` is measured with the video fixture in B, as the delta over an image+video frame.
- **shots**: 4 theme states with animations frozen and canvases hidden; pixel diff vs `baseline/shots`.

`baseline/bench.json` is the original v1.5 build on an M1 (Chromium, ANGLE Metal).
