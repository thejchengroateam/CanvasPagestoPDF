# Canvas Pages to PDF (Chrome Extension)

A lightweight Chrome Extension that converts Instructure Canvas LMS pages into clean, vector-rendered, selectable-text PDFs without Canvas navigation bars or sidebar clutter.

---

## Features

- **Removes Canvas UI**: Strips out navigation drawers, sidebars, header breadcrumbs, bottom edit bars, and grade/admin widgets.
- **Selectable & Searchable Text**: Produces real vector PDFs rather than raster pixel screenshots—text can be highlighted, copied, and searched.
- **No Page Break Gaps & Slices**: Custom CSS rules (`break-inside: avoid;`) prevent tables, code snippets, blockquotes, and diagrams from being chopped in half across pages.
- **Preserves Full Styles & Assets**: Automatically resolves relative Canvas course links, images, tables, math formulas, and styling.
- **Zero Authentication / CORS Hassle**: Because it runs natively in your browser session as a Chrome Extension, it already has access to the open Canvas page without requiring Canvas developer API keys.

---

## Installation in Chrome / Brave / Edge

1. Open your browser and navigate to the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the folder:
   ```
   c:\Users\johncarlo\Documents\GitHub\CanvasPagestoPDF
   ```
5. Pin the extension to your toolbar for quick access.

---

## How to Use

1. Go to any Canvas LMS page (e.g., Pages, Syllabus, Modules, Assignments).
2. Click the **Canvas to PDF** icon in your browser toolbar.
3. The popup will verify the active page.
4. Click **Download PDF**.
5. The print dialog will open automatically:
   - Ensure the destination is set to **Save as PDF**.
   - Under *More settings*, ensure **Background graphics** is checked (to keep Canvas callouts, cards, and colors).
6. Click **Save**.
