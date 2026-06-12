```
███╗   ███╗       ██████╗ ██████╗     ██████╗ ██╗  ██╗
████╗ ████║      ██╔═══██╗██╔══██╗    ██╔══██╗██║  ██║
██╔████╔██║█████╗██║   ██║██████╔╝    ██████╔╝███████║
██║╚██╔╝██║╚════╝██║   ██║██╔══██╗    ██╔═══╝ ██╔══██║
██║ ╚═╝ ██║      ╚██████╔╝██║  ██║██╗ ██║     ██║  ██║
╚═╝     ╚═╝       ╚═════╝ ╚═╝  ╚═╝╚═╝ ╚═╝     ╚═╝  ╚═╝
```

VJ software is a racket. the good tools are locked behind subscriptions, the free ones are toys, and the cracks carry malware. m-or.ph is what happens when you stop waiting for someone to build the right thing and just build it yourself. runs entirely in a browser. does exactly what it says.

built by [vandope](https://instagram.com/vandope__) — visual engineer and creative technologist, Manila, Philippines.

---

## table of contents

- [quick start](#quick-start)
- [what it does](#what-it-does)
- [the stack](#the-stack)
- [architecture](#architecture)
  - [render pipeline](#render-pipeline)
  - [the GL processor](#the-gl-processor)
  - [CPU effect path](#cpu-effect-path)
  - [performance governor](#performance-governor)
  - [capture pipeline](#capture-pipeline)
  - [output window](#output-window)
- [feature inventory](#feature-inventory)
  - [sources](#sources)
  - [effects](#effects)
  - [modulators](#modulators)
  - [output & display modes](#output--display-modes)
- [performance engineering](#performance-engineering)
- [UI system](#ui-system)
- [keyboard shortcuts](#keyboard-shortcuts)
- [persistence](#persistence)
- [browser support & permissions](#browser-support--permissions)
- [project status](#project-status)

---

## quick start

```
1. open index.html in Chrome (or any Chromium browser)
2. that's it
```

no build step. no dependencies to install. no server required (a static file server helps with some browser permission prompts, but `file://` works). the only network requests are Google Fonts for the eight pixel typefaces and the Internet Archive API if you use the archive sources.

first launch auto-starts the interactive in-app tutorial. it remembers where you left off via `localStorage`.

## what it does

- **two input slots (A / B)** — video files, images, live webcam, screen capture, typed text, solid colors, procedural patterns, mathematical/fractal generators, or footage pulled straight from the Internet Archive
- **a crossfader** that blends A and B before the chain
- **an effects rack** — up to 5 stacked effects across three categories: processors (clean transforms), glitch (controlled destruction), and modulators (automation that drives other knobs)
- **drag-to-reorder chain** — effect order changes everything; color→glitch ≠ glitch→color
- **live output** to a popup window you can drag to a projector and fullscreen with `F`
- **capture** — PNG photos and WebM recordings (up to 60s) at canonical 720p, croppable to 16:9 / 1:1 / 9:16
- **TV mode** — the entire UI re-lays itself out for a real 640×480 4:3 CRT television, paginated into 4 "channels"
- **CRT mode** — scanlines, phosphor fuzz, vignette, and random glitch tears over the whole interface
- **Web MIDI** — hardware crossfader control out of the box
- **audio-reactive modulation** — drive any knob from your microphone's bass/mid/treble/transients

## the stack

| layer | choice | notes |
|---|---|---|
| language | vanilla JavaScript (ES2020+) | zero frameworks, zero build tooling, zero npm |
| rendering | hybrid **WebGL 1 + Canvas 2D** | GL for shader-friendly effects, CPU `ImageData` loops for everything else |
| architecture | **single HTML file** (~10,700 lines) | CSS + markup + JS in one artifact; the whole app is one `index.html` |
| styling | hand-rolled CSS, 1-bit Mac System 7 dithered aesthetic | SVG data-URI dither patterns, two colors (`--ink` / `--paper`), CSS-class-based state |
| fonts | 8 pixel/1-bit faces via Google Fonts | Press Start 2P, VT323, Silkscreen, Tiny5, Pixelify Sans, DotGothic16, Departure Mono, Share Tech Mono |
| media APIs | `getUserMedia`, `getDisplayMedia`, `MediaRecorder`, `canvas.captureStream`, Web MIDI, Web Audio (`AnalyserNode`) | |
| external data | Internet Archive metadata + advancedsearch APIs | for the `archive` and `random` sources |
| state | a single mutable `state` object + per-source / per-module objects | no store library; the render loop is the source of truth |

the single-file constraint is deliberate: the app is distributed as one artifact you can email, host anywhere, or open from disk. v2 will revisit this (see [project status](#project-status)).

## architecture

### render pipeline

one `requestAnimationFrame` loop (`renderFrame`) drives everything, top to bottom, every frame:

```
sources A + B  ──►  per-source canvases (video / webcam / generative draw)
       │
       ▼
   MIXER (Canvas 2D)
   crossfade A↔B with transparency-aware alpha rules
   (text/image sources composite over instead of fading through black)
       │
       ▼
   EFFECT CHAIN  (state.modules, in order, max 5)
   for each enabled module:
     MODULE_PROCESSORS[name](mod, currentCanvas) → returns processed canvas
     bypassed modules are skipped entirely — zero cost
       │
       ▼
   MODULATOR TICKS
   tickLFOs / tickAudio / tickSequencers /
   tickPerlin / tickXYPads / tickRandomWalks
   (write directly into target module params or the crossfader)
       │
       ▼
   OUTPUTS
   ├─ master preview canvas (UI, throttled)
   ├─ full-res output canvas → output window (cross-window drawImage)
   ├─ fixed-720p recording canvas (while MediaRecorder is active)
   └─ PiP popup
```

key properties:

- **internal resolution is 16:9 HD** in normal mode, **4:3 SD** in TV mode. everything in the chain processes at this size; capture upscales separately (see below).
- **the chain is pull-free and stateless between frames** except where effects intentionally keep buffers (feedback, datamosh, color trails). each module receives the previous module's output canvas and returns its own offscreen canvas.
- **UI thumbnails are throttled independently of the render loop** — 15fps normally, 8fps when output is streaming or the governor is in eco mode. the audience-facing output always runs at full rate; only your previews degrade.
- **per-module error isolation** — a throwing processor logs once (`mod._procWarned`) and the chain advances past it instead of killing the frame.

### the GL processor

`GLProcessor` is a self-contained IIFE wrapping a single WebGL 1 context shared by every GL-capable effect:

- **shader cache** — fragment shaders compile lazily on first use and are cached by name
- **ping-pong FBOs** — two framebuffer textures alternate as render targets, so multi-pass effects never read and write the same texture
- **uniform convention** — every shader gets `u_src` (input), `u_t` (intensity), `u_p` (param), `u_time`, `u_res`, plus optional `u_b`/`u_prev` on texture unit 1 for effects that need a second input (keyer, feedback)
- **readback bridge** — GL output is read back into each module's offscreen 2D canvas so GL and CPU effects can interleave freely in one chain. this is the expensive part, and it's where the most important optimization lives:

```js
// Readback scratch buffers are allocated once and reused every frame —
// allocating W*H*4 bytes twice per GL module per frame caused ~470MB/s of
// GC pressure at 854×480. Invalidated on resize.
let _readBuf=null,_readId=null,_readW=0,_readH=0;
```

a pre-allocated `Uint8Array` + `ImageData` pair lives at IIFE scope, sized to W×H×4, and is only re-allocated when the resolution actually changes. the row-flip (WebGL is bottom-up, canvas is top-down) happens in-place via `subarray` views — no per-frame allocation anywhere in the hot path.

- **graceful degradation** — if `GLProcessor.ready()` is false (no WebGL), every GL-mapped effect falls back to its CPU implementation. the app runs fully without WebGL, just slower.

### CPU effect path

effects without a GL mapping (and all GL fallbacks) operate on raw `ImageData`:

- contexts that read pixels are created with `{willReadFrequently:true}`
- persistent buffers (feedback frames, datamosh accumulation buffers, color-trail buffers, keyer temp canvases) are **cached on the module instance**, not allocated per frame
- `removeModule` explicitly nulls every canvas, context, and typed-array reference a module holds — array filtering alone leaves GPU/canvas resources reachable and leaks them

### performance governor

an adaptive quality ladder defends a 24fps floor. evaluated once per second from measured FPS, with hysteresis so it never oscillates:

| level | behavior |
|---|---|
| **L0** | full quality |
| **L1** | heavy modules process every other frame (cached result reused), UI thumbnails throttle to 8fps |
| **L2** | L1 + internal processing resolution drops to 0.75× |
| **L3** | L1 + internal resolution drops to 0.5× |

- demote: `fps < 28` steps down one level per second
- promote: `fps ≥ 50` for 3 consecutive seconds steps back up
- resolution changes snap to even dimensions and clamp at 160×120 minimum
- on top of the governor, the UI enforces **hard limits: 5 modules total, 2 HEAVY modules max**. heavy items grey out in the picker when the budget is spent.
- the FPS counter lives in the bottom bar. below 15 it warns; below 10 with CRT mode active, a critical popup offers a one-click "turn off CRT" escape hatch (60s dismiss cooldown, dark-mode safe via double-invert CSS).

### capture pipeline

captures always render at **canonical 720p regardless of governor state**: 1280×720 for 16:9, 960×720 for 4:3 (TV mode). the final mix is upscaled nearest-neighbor — no detail is invented (an eco-level frame stays soft), but file dimensions stay standard and a recording's frame size can never change mid-stream when the governor shifts levels.

- **photo** — PNG of the current frame, white-flash confirmation
- **video** — `canvas.captureStream(30)` → `MediaRecorder`, WebM with VP9 (VP8 fallback), 8 Mbps, 60-second cap
- **aspect crop** — 16:9 / 1:1 / 9:16 applied at save time only; the live pipeline is untouched
- **countdown** — optional 3s, ticks inline in the panel, `Esc` cancels

### output window

the audience window is a `window.open` child with a single canvas. the parent draws the master output into it **cross-window** every frame via `drawImage` — no `BroadcastChannel` frame shipping, no `captureStream` piping, just direct same-origin canvas access. the child binds `F` → fullscreen. a 1s close-watcher resets streaming state and clears per-module frame-skip caches when the window goes away.

## feature inventory

### sources

each of the two input slots accepts one source. all sources share base controls (size, rotate, fade); several add their own.

| source | what it is | extras |
|---|---|---|
| **video** | local file (MP4/WebM/MOV/most formats) | speed, loop; auto-loops with a 5s crossfade at the loop point |
| **image** | local still (JPG/PNG/GIF/WebP) | 8 appear/disappear animations (fade, blink, dissolve, wipe, scan, zoom, glitch, rotate), 0–4s duration, manual ▶in/◀out triggers |
| **text** | typed text rendered as a transparent-background source | 8 pixel fonts, 8 color presets, multi-line, auto-sizing |
| **webcam** | live camera | device selector for multiple cams, Flip H/V; USB capture cards appear as webcams (RCA→HDMI→USB chains work) |
| **screen capture** | any window, tab, or full screen via `getDisplayMedia` | capture a YouTube tab as a source, or capture another m-or.ph window to chain two instances |
| **archive** | paste any archive.org page URL | hits the metadata API, picks the best-quality .mp4 automatically |
| **random** | 6 random Internet Archive videos | heavily filtered advancedsearch query, ~33min duration cap, refresh for a new set |
| **solid color** | flat color fill | 10 swatches; pairs with the keyer as a background layer |
| **moving pattern** | procedural animated visuals | plasma, dye drop (real velocity-field sim), radial pulse, interference, hex grid, starfield, noise field, vortex; speed control |
| **mathematical** | genuinely non-repeating generative systems | Lorenz / De Jong / Ikeda attractors, Lissajous, Voronoi, Newton fractal, Mandelbrot zoom, Julia set — none ever settle or repeat |

sources are hot-swappable mid-set via **REPLACE** (no output interruption) and **A↔B swap**.

### effects

three categories, up to 5 in the chain, max 2 HEAVY. every effect has presets (modes) and knobs (intensity + param), a bypass eye, and a ⠿ drag handle for reordering.

**processors** — clean, non-destructive transforms:

| effect | modes | heavy |
|---|---|---|
| **keyer** | luma dark/bright/invert, chroma green/blue/custom, color isolate, contrast key — composites raw B over the chain at its position | |
| **color** | hue rotate, saturation, false color, palette reduce, channel remap, duotone, LUT, color trails | |
| **geometry** | scale, rotate, tile, kaleidoscope, mirror, perspective, polar warp, ripple | |
| **feedback** | echo decay, zoom pulse, rotation drift, edge bleed, color accumulate, strobe freeze, luma gate | HEAVY |
| **pixel operations** | edge detect, emboss, erosion, dilation, posterize, threshold, bloom, chroma aberration | HEAVY |
| **ascii** | ascii, braille, binary 01, japanese (katakana/hex), block symbols, halftone, scan lines, crosshatch | HEAVY |

**glitch** — breaks the image on purpose:

| effect | modes | heavy |
|---|---|---|
| **VHS** | tracking, color bleed, luma wobble, tape crinkle, chroma shift, static burst, head switch, full VHS | |
| **signal noise** | RGB / luma / chroma noise, quantize, salt & pepper, hue drift, bit flip, full noise | |
| **row shift** | scan drift, tear line, sync loss, interlace, field flip, scan line, jitter, full shift | |
| **datamosh** | flow smear (real motion-vector mosh), I-frame drop, ava/lanche, warp wave, pixel frame, delta blend, bit crush, displace | HEAVY |
| **block corrupt** | DCT block, tile swap, color block, freeze block, stream corrupt, macro block, ghost block, full corrupt | HEAVY |
| **pixel sort** | brightness, dark, hue, saturation, horizontal, vertical, droopy, full sort | HEAVY |

### modulators

modulators don't process video — they move other knobs automatically via **send to →**. multiple modulators can run simultaneously on different targets, including the master crossfader.

| modulator | behavior | heavy |
|---|---|---|
| **oscillator (LFO)** | sine / square / saw / burst, rate + depth | |
| **XY pad** | one draggable pad, two independent routed outputs (X and Y) | |
| **random walk** | slow/medium/fast drift, stepped, drunk walk, pendulum, gravity pull, Brownian — with scrolling history waveform | |
| **sequencer** | 8 drag-editable steps on a clock, looping | HEAVY |
| **audio** | mic analysis — bass/mid/treble bands, RMS, peak, transient (kick detection), inverted variants | HEAVY |
| **perlin noise** | slow drift, turbulence, domain warp, ridged, billow, fractal fBm, warp feedback, cellular | HEAVY |

### output & display modes

- **three monitoring views** (all for you, not the audience): center preview, master preview panel, draggable/resizable PiP popup (240×135 / 400×225 / 560×315)
- **output window** — the audience view; second screen / projector + `F` for fullscreen
- **capture panel** — photo + video as described above
- **dark/light theme** — inverts the UI only, never the video
- **CRT mode** — scanline/phosphor/vignette/glitch overlay across the entire interface; stacks with either theme
- **TV mode** — full 640×480 4:3 re-layout for a real CRT television, auto-fullscreen, scaled-transform stage, UI paginated into 4 channels (CH1 output, CH2 chain, CH3 inputs, CH4 fx; keys `1–4`). entering TV mode drops render output to 4:3 480p and disables the CRT overlay (a real tube brings its own scanlines); exiting restores 854×480 and your overlay setting
- **MIDI** — Web MIDI; CC7 maps to the crossfader, activity dot flashes on messages

## performance engineering

the v1.5 cleanup pass (independent audit + seven fixes) is what the current numbers stand on. the headline items, useful as patterns for anyone touching the hot path:

1. **per-frame heap churn in GL readback** — `_readToCanvas` allocated two W×H×4 buffers per GL module per frame: **~470MB/s of GC pressure** at 854×480 with a couple of GL effects active. fixed by pre-allocating the read buffer and `ImageData` at IIFE scope, invalidated only on resize.
2. **canvas/buffer leak in `removeModule`** — filtering a module out of the array left its offscreen canvases, contexts, and accumulation buffers reachable. fixed with explicit nulling of every resource reference on removal.
3. **keyer temp canvas** — was created per frame; now cached on the module instance.
4. **dead code removal** — `shouldSkipHeavy()` and `_glToCanvas` (superseded by the governor and `_readToCanvas` respectively), plus a vestigial `_loadingSlot` guard.
5. **CSS-class state over inline styles** — rgba opacity manipulation replaced with classes (e.g. `src-list-dim`) for 1-bit spec compliance and maintainability.

general rules encoded in the codebase:

- **nothing allocates in the hot path.** buffers live at module or IIFE scope.
- **bypass is free.** disabled modules cost zero — no processing, no thumbnail draw.
- **the audience never pays for your UI.** thumbnail throttling and governor degradation hit previews and internal resolution first; output framerate is the last thing to go.
- **resolution is the pressure-release valve.** the governor trades pixels for frames, and capture decouples file resolution from processing resolution so the trade is invisible in saved output.

## UI system

- **1-bit Mac System 7 aesthetic** — two colors, SVG data-URI dither patterns at 25%/50%, hard 2px borders, pixel fonts, `shape-rendering: crispEdges` everywhere
- **contextual help engine** — a `TIPS` dictionary maps every hoverable element to a titled tip list; the GETTING STARTED panel updates live on hover (lockable by click). this doubles as the app's inline documentation.
- **interactive tutorial** — 5 chapters, ~28 steps, each with a hand-built animated 1-bit SVG illustration. steps can be *concept* slides or *task* slides with `complete:` predicates that watch real app state (e.g. `()=>sources.A.active`) and auto-advance when you actually do the thing. progress persists; finished users get a free-clicking review mode.
- **signal chain bar** — live `[A + B] · mixer · effect · … · master output` readout; click any name to jump to that module.
- **status bar** — single-line app state; first place to look when something breaks.

## keyboard shortcuts

| key | context | action |
|---|---|---|
| `F` | output window / main UI | fullscreen |
| `1`–`4` | TV mode | switch channel (output / chain / inputs / fx) |
| `Esc` | everywhere | cancel pick mode, close capture panel, cancel countdown, exit fullscreen, pause tutorial |
| `Enter` | dialogs / hex input | confirm |

## persistence

m-or.ph stores almost nothing. `localStorage` keys:

| key | purpose |
|---|---|
| `morph_tut_step` | tutorial resume position |
| `morph_tut_done` | tutorial completed flag (enables review mode) |
| `morph_tut_highest_ch` | highest chapter reached |
| `morph_skip_shown` | skip-confirmation throttle |

no accounts, no cookies, no analytics, no uploads. your media never leaves your machine (archive sources stream *from* archive.org, nothing goes to it).

## browser support & permissions

- **Chrome / Chromium-based browsers recommended.** the app leans on `getDisplayMedia`, `MediaRecorder` WebM, Web MIDI, and cross-window canvas access — all strongest in Chromium.
- permission prompts you may see, each only on first use of the relevant feature: **camera** (webcam source), **microphone** (audio modulator), **screen** (screen capture source), **MIDI** (MIDI toggle).
- popups must be allowed for the output window. if it opens as a tab, drag it out.

## project status

current version: **v1.5** — the audited, optimized single-file build, cleared as the foundation for v2.

| | |
|---|---|
| **v1.5 (this)** | single `index.html`, hybrid GL/CPU pipeline, performance governor, TV mode, full tutorial |
| **v2 (next)** | new architecture built on the v1.5 cleanup; the single-file constraint is on the table |

---

*m-or.ph built by vandope. follow him on [instagram.com/vandope__](https://instagram.com/vandope__)*
