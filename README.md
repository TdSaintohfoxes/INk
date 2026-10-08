# INK

A private, offline reader for EPUB, PDF and comics (CBZ/CBR). No accounts, no ads, no uploads — your library lives on your device.

Plain JavaScript modules, no build step. Host the folder as-is (GitHub Pages works) and install it from the browser menu.

- `index.html`, `ink-app.js` — shell, router, import
- `ink-engine-epub.js`, `ink-engine-pdf.js`, `ink-engine-comic.js` — the three readers
- `vendor-pdf*.mjs` — PDF.js (Apache-2.0, see `vendor-pdfjs-LICENSE.txt`)
- `sw.js`, `manifest.json` — offline support and installability

RAR-compressed .cbr files need the optional `vendor-libarchive.js` add-on; ZIP-based .cbr/.cbz work out of the box.
