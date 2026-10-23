# Canvas Pages to PDF (Chrome Extension)

A lightweight Chrome Extension that converts Instructure Canvas LMS pages into clean, vector-rendered, selectable-text PDFs without Canvas navigation bars or sidebar clutter.

---

## Key Features

- **Removes Canvas UI**: Strips out navigation drawers, sidebars, header breadcrumbs, bottom edit bars, and grade/admin widgets.
- **Selectable & Searchable Text**: Produces real vector PDFs rather than raster pixel screenshots—text can be highlighted, copied, and searched.
- **Intelligent Layout & Pseudo-Heading Detection**: Automatically detects section titles, subheadings, and dividers even when professors format pages using non-standard HTML tags (e.g., styled `<p>`, bold `<div>`, or `<span>`), preventing orphaned titles.
- **Smart Table & Header Protection**: Small and moderate tables remain intact on a single page, while multi-page tables repeat `<thead>` headers cleanly without orphaned table header rows.
- **Bullet & List Pagination Intelligence**: Protects list items from being cut in half, prevents solitary bullet points from being orphaned on a new page, and recognizes custom paragraph bullets (`•`, `-`, `1.`).
- **Triple-Stage Image Preloading**: Swaps lazy attributes (`data-src`), triggers `IntersectionObserver` triggers via a rapid virtual viewport scroll, and awaits `img.decode()` to eliminate missing images or blank boxes.
- **Banner & Callout Box Preservation**: Identifies colored banners, alerts, blockquotes, and note boxes via computed styles, ensuring they don't get chopped across page boundaries.
- **Preserves Full Styles & Dark Modes**: Retains custom backgrounds, colors, and BetterCanvas themes via `color-adjust: exact`.
- **Zero Authentication / CORS Hassle**: Runs natively in your browser session as a Chrome Extension with access to the open Canvas page—no developer API keys or server required.

---

## Technical Architecture & How It Works

### 1. In-Place Preloading Pipeline
When you click **View PDF**, the extension executes directly in the context of the active Canvas tab:
1. **Un-lazy-load Images**: Resolves Canvas and CDN lazy-load dataset attributes (`data-src`, `data-original`, `data-srcset`) to immediate `src` and sets `loading="eager"`.
2. **Virtual Viewport Sweep**: Executes a rapid scroll sweep across the page to trip lazy-load `IntersectionObserver` thresholds.
3. **Hardware Decode Verification**: Awaits `img.decode()` across all images within the content container with a safety timeout fallback.
4. **Expand Collapsible Elements**: Automatically forces closed `<details>` tags to `<details open>` so hidden accordions aren't dropped.

### 2. Multi-Pass DOM & Computed Style Analyzer (`detectAndTagPrintElements`)
Canvas course pages rarely follow rigid semantic HTML standards. The built-in layout analyzer runs prior to printing:
- **Pass 1 (Spacer Cleaner)**: Identifies empty spacer paragraphs (`<p>&nbsp;</p>`, `<p><br></p>`) caused by repetitive Enter keystrokes and suppresses them in print.
- **Pass 2 (Visual Headings & Lead-ins)**: Calculates computed font size ratios (`>= 1.15x`), font weights (`>= 600`), bottom borders, and attached `<hr>` dividers to classify visual headings, applying `break-after: avoid !important`. Lead-in sentences ending in colons (`:`) are linked to their subsequent lists or tables.
- **Pass 3 (Table Engine)**: Tags moderate-sized tables (<= 16 rows) to stay together, forces `thead` to `display: table-header-group !important`, avoids breaks between `thead` and initial rows, and unlocks parent overflow wrappers (`overflow: visible !important`).
- **Pass 4 (List Engine)**: Protects individual `li` items (`break-inside: avoid !important`), enforces `break-after: avoid` on initial items, and sets `break-before: avoid` on the final item so single bullets never stand alone at page boundaries. Also recognizes custom paragraphs starting with bullets (`•`, `-`, `*`) or numbers (`1.`, `a)`).
- **Pass 5 (Cards & Callouts)**: Inspects computed background colors and border-accented containers to preserve alert callouts and note cards intact.

### 3. Dedicated Clean Print Stylesheet & Reversible Cleanup
- Injects an isolated `@media print` stylesheet that hides all Canvas navigation, search bars, and tools while leaving course content in high-fidelity vector format.
- Attaches an `afterprint` listener that strips all temporary classes and stylesheets immediately upon closing the print dialog, leaving the live page completely untouched.

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
