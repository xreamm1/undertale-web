# Undertale Web

Browser launcher for Undertale's Steam data files, using the Butterscotch WebAssembly runner and WebGL2. Static hosting; no build step. Open the GitHub Pages URL: the game starts automatically once resources and saves are ready. Audio is unlocked on the first touch or key press; fullscreen is available in settings because browsers require a user gesture for it.

Fullscreen requests landscape orientation after entering fullscreen. When orientation lock is unavailable or rejected, portrait screens show a manual rotation hint. Leaving fullscreen releases orientation lock. Support depends on the mobile browser.

## Controls

Mobile screens have persistent Z (confirm/interact), X (cancel/advance text), and C (menu) buttons on the right. Each captured pointer owns its key state, so movement and actions can be held together. Control reference: https://gamefaqs.gamespot.com/pc/180989-undertale/faqs/81196/controls

All loader text uses local 8bitoperator JVE, with 8bitOperatorPlus for Cyrillic glyphs missing from the original face. Font credits and licensing are in `fonts/NOTICE.txt` and `fonts/OFL.txt`. Both fonts are precached for offline loading.

Arrows move; Z confirms, X cancels, C opens the menu. Touch controls: visible left dynamic joystick; right tap confirms; right hold (300 ms) holds cancel. Moving cancels the pending hold. The gear button reveals settings, save management and the battle-mode switch. In battle mode, the joystick disappears and movement is relative, including over letterbox areas. This stock runner does not export battle/HP state; mode switching is manual, relative keyboard movement is approximate, and automatic damage vibration requires instrumenting the runner. No claim of pixel-perfect finger tracking or complete game compatibility is made.

The pixel-art launch screen has a flat red soul, overall progress and five component rows: streamed WASM module bytes, streamed data.win bytes (memory image), audio bytes (archives), completed files (chunks), and completed initialization stages (host boot). Counts and sizes reflect this build, rather than example numbers from a reference image.

## Storage

Game resources use Cache First in `undertale-cache-v1`. Browser storage is not permanent: the browser or user can remove it. Persistent storage is requested at game start. Saves are read from the runner's `/saves` directory and mirrored atomically into IndexedDB once per second. Export creates a portable JSON file; import replaces the browser snapshot and restarts. This runner uses WASMFS rather than GameMaker HTML5 localStorage.

## Deployment

GitHub Pages, deploy branch `main`, root directory. Assets are relative to the repository URL. `assets.json` enumerates all game resources with exact uncompressed byte lengths. Increment shell cache version when changing shell/runtime files; change game cache version when replacing game assets. HTTPS is required. No pthreads are used by this runner. COOP/COEP are added to controlled navigations by the service worker; the first uncontrolled page load is not cross-origin isolated. A future threaded build requires server-provided headers or a controlled reload and a verified `crossOriginIsolated` value.

## Third-party runtime and source

Butterscotch is a third-party GameMaker runner, licensed under GNU AGPL v3. Its original authors and source history are retained upstream. This project uses the official web autobuild downloaded from the upstream `build/main/butterscotch-web.zip` workflow on 2026-11-11. The WASM binary is unmodified. The JavaScript bridge has one modified call site importing `runtime/audio-buffer.mjs`; both modified sources are published here under AGPL-3.0 alongside the baseline source archive.

Audio uses an output buffer of at least 4096 frames, subdivided into the native mixer's original blocks. This preserves the size of the native WASM allocation while giving the main thread more time before an audio deadline. It adds output latency (4096 / sample rate seconds per buffer, about 85 ms at 48 kHz); long main-thread stalls can still cause interruptions. Audio resume is requested only for suspended/interrupted contexts. Runtime logging avoids updating hidden DOM during gameplay. Fatal errors display their captured runner log and a restart action; this does not imply that all native runtime aborts have been resolved.

- Source: https://github.com/ButterscotchRunner/Butterscotch
- Source revision at download: `ec4fc0b0a3669b7ea36e8e37ed94de16f96d1624`
- Corresponding source archive is included as `runtime/corresponding-source.zip`.
- License: [runtime/LICENSE](runtime/LICENSE)
- Build instructions and dependencies are in the corresponding source archive.

Undertale game data, music, artwork and game code remain © Toby Fox and their respective authors. The runner license does not license the game assets. This is an unofficial browser adaptation, not an official HTML5 export.
