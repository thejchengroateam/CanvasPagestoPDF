# Canvas Pages to PDF (Chrome Extension)

A lightweight Chrome Extension that converts Instructure Canvas LMS pages into clean, vector-rendered, selectable-text PDFs without Canvas navigation bars or sidebar clutter.

---

## Key Features

- **Removes Canvas UI**: Strips out navigation drawers, sidebars, header breadcrumbs, bottom edit bars, and grade/admin widgets.
- **Selectable & Searchable Text**: Produces real vector PDFs rather than raster pixel screenshots—text can be highlighted, copied, and searched.
- **Intelligent Layout & Pseudo-Heading Detection**: Automatically detects section titles, subheadings, and dividers even when professors format pages using non-standard HTML tags (e.g., styled `<p>`, bold `<div>`, or `<span>`), preventing orphaned titles.
- **Smart Table & Header Protection**: Small and moderate tables remain intact on a single page, while multi-page tables repeat `<thead>` headers cleanly without orphaned table header rows.
- **Bullet & List Pagination Intelligence**: Protects list items from being cut in half, prevents solitary bullet points from being orphaned on a new page, and recognizes custom paragraph bullets (`•`, `-`, `1.`).
- **No Stranded Headings**: A detected heading, section banner or sub-heading is glued to the block that follows it, so it moves to the next page together with its content instead of sitting alone at the bottom of a page. (Skipped when *Compact Layout* is on, where saving pages matters more.)
- **Triple-Stage Image Preloading**: Swaps lazy attributes (`data-src`), triggers `IntersectionObserver` triggers via a rapid virtual viewport scroll, and awaits `img.decode()` to eliminate missing images or blank boxes.
- **Banner & Callout Box Preservation**: Identifies colored banners, alerts, blockquotes, and note boxes via computed styles, ensuring they don't get chopped across page boundaries.
- **Preserves Full Styles & Dark Modes (readable)**: Retains custom backgrounds, colors, and BetterCanvas themes via `color-adjust: exact`, then normalizes dark-theme palettes instead of fading them. Text that was coloured for a dark page is darkened so it stays legible on the white PDF, translucent dark-mode "surfaces" become matching light tints, and anything that already contrasts well (colored callouts, dark cards with white text) is left untouched.
- **Zero Authentication / CORS Hassle**: Runs natively in your browser session as a Chrome Extension with access to the open Canvas page—no developer API keys or server required.

---

## Technical Architecture & How It Works

### 1. Isolated Copy Pipeline (safe on React-rendered pages)
When you click **View PDF**, the extension executes in the context of the active Canvas tab, but it never edits Canvas' DOM **and never restyles it**. The content is copied into a separate, offscreen document (an iframe) and everything happens there:
1. **Lazy-load Warm-Up**: A rapid scroll sweep (scroll position is restored afterwards) trips Canvas' lazy-load observers so media is already requested.
2. **Separate Document**: An offscreen iframe gets a copy of the page's stylesheets, theme hooks (`html`/`body` classes, inline style variables), and a `<base>` URL, so Canvas CSS resolves exactly as on the page.
3. **Deep Copy + Ancestor Shell**: The content node is cloned together with shallow copies of its ancestors, so Canvas' own descendant selectors (e.g. `#assignment_show .user_content`) still style the copy — inside the copy's document, so no duplicate ids ever reach Canvas.
4. **Media Resolution**: Lazy `src`/`srcset` attributes are resolved on the copy, `<canvas>` drawings are snapshotted to images, and images are awaited with `decode()`.
5. **Embedded Frames**: Same-origin frames (the text-entry editor, embedded Canvas content) are copied inline; cross-origin LTI / Studio / YouTube frames are replaced with a labelled placeholder so a tool is never launched twice.
6. **Details Expansion**: Closed `<details>` elements are opened on the copy.

The print dialog is opened on the copy's document (`iframe.contentWindow.print()`), so Canvas never enters print media at all — its React containers keep their size and no resize callbacks fire while the preview is open.

### 2. Multi-Pass DOM & Computed Style Analyzer (`detectAndTagPrintElements`)
Canvas course pages rarely follow rigid semantic HTML standards. The built-in layout analyzer runs prior to printing:
- **Pass 1 (Spacer Cleaner)**: Identifies empty spacer paragraphs (`<p>&nbsp;</p>`, `<p><br></p>`) caused by repetitive Enter keystrokes and suppresses them in print.
- **Pass 2 (Visual Headings & Lead-ins)**: Calculates computed font size ratios (`>= 1.15x`), font weights (`>= 600`), bottom borders, and attached `<hr>` dividers to classify visual headings, applying `break-after: avoid !important`. Lead-in sentences ending in colons (`:`) are linked to their subsequent lists or tables.
- **Pass 3 (Table Engine)**: Tags moderate-sized tables (<= 16 rows) to stay together, forces `thead` to `display: table-header-group !important`, avoids breaks between `thead` and initial rows, and unlocks parent overflow wrappers (`overflow: visible !important`).
- **Pass 4 (List Engine)**: Protects individual `li` items (`break-inside: avoid !important`), enforces `break-after: avoid` on initial items, and sets `break-before: avoid` on the final item so single bullets never stand alone at page boundaries. Also recognizes custom paragraphs starting with bullets (`•`, `-`, `*`) or numbers (`1.`, `a)`).
- **Pass 5 (Cards & Callouts)**: Inspects computed background colors and border-accented containers to preserve alert callouts and note cards intact.
- **Pass 6 (Heading ↔ Content Glue)**: Chromium ignores `break-after: avoid` / `break-before: avoid`, so those rules alone cannot stop an orphaned banner. Instead each detected heading is wrapped together with the block that follows it (banner shells such as *title + meta line* are climbed first, and pairs taller than ~0.8 of a printed page are left alone), giving the pair `break-inside: avoid !important` — the one fragmentation rule Chromium does honor. Disabled in compact mode.

### 3. Dedicated Clean Print Stylesheet & Reversible Cleanup
- The copy's own document carries an isolated `@media print` stylesheet, so no Canvas navigation, search bars, or sidebar clutter reach the PDF (and hidden chrome no longer reserves a blank first page).
- Because every change lives inside the copy's own document, cleanup is a single `iframe.remove()` call. The `afterprint` listener (with `pagehide` and a timeout safety net) drops the copy and restores the tab title, leaving the live Canvas page byte-for-byte untouched — no added ids, no added stylesheets, no layout changes.

### 4. Print Readability Pass
Dark Canvas themes (and dark-mode extensions) color text for a dark page, so printing them onto white paper used to produce near-invisible grey-on-white text. Before printing, the copy is walked top-down and each text run is measured against the background actually behind it (composited through translucent surfaces):
- Text below a 2.5:1 contrast ratio is re-tinted in its own hue (dark text for light backgrounds, light text for dark ones). Content that already contrasts well is never touched, so colored callouts, banners and dark cards keep their intended look.
- Translucent white "surfaces" from a dark theme (`rgba(255,255,255,.06)` panels) are flipped to an equivalent light tint so section boxes stay visible on white.
- Containers at ≤ 15% opacity (faded loading states) are restored to full opacity.

The full investigation behind these mechanisms — every failure mode, the measurements that identified it, and the verification results — is documented in [CASE-STUDY.md](CASE-STUDY.md).

---

## Installation in Chrome / Brave / Edge

1. Open your browser and navigate to the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the project root folder:
   ```
   c:\Users\johncarlo\Documents\GitHub\CanvasPagestoPDF
   ```
5. Pin the extension to your toolbar for quick access.

---

## How to Use

1. Navigate to any Canvas LMS page (such as Pages, Syllabus, Modules, or Assignments).
2. Click the **Canvas to PDF** icon in your browser toolbar.
3. The popup will verify the active page.
4. Click **View PDF**.
5. The print dialog will open automatically:
   - Set the destination to **Save as PDF**.
   - Under *More settings*, ensure **Background graphics** is checked (to keep Canvas callouts, cards, and colors).
6. Click **Save**.
