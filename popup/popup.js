// Popup script: handles user trigger and coordinates page extraction
document.addEventListener('DOMContentLoaded', async () => {
  const pageTitlePreview = document.getElementById('page-title-preview');
  const btnConvert = document.getElementById('btn-convert');
  const btnText = document.getElementById('btn-text');
  const statusMsg = document.getElementById('status-msg');
  const themeWarning = document.getElementById('theme-warning');
  const btnOpenInfo = document.getElementById('btn-open-info');

  if (btnOpenInfo) {
    btnOpenInfo.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('info/info.html') });
    });
  }

  // Query active tab
  let activeTab;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];
  } catch (err) {
    showStatus('Unable to access current tab.', 'error');
    return;
  }

  if (!activeTab || !activeTab.id) {
    showStatus('No active tab found.', 'error');
    return;
  }

  // Check if active tab is likely Canvas or regular page
  const tabUrl = activeTab.url || '';
  const isLikelyCanvas = tabUrl.includes('/courses/') || tabUrl.includes('canvas') || tabUrl.includes('instructure');

  if (isLikelyCanvas) {
    pageTitlePreview.textContent = activeTab.title || 'Canvas Page Ready';
    
    // Check for custom theming or dark mode on active Canvas tab
    try {
      const themeResults = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: detectCanvasTheming
      });
      const themeData = themeResults && themeResults[0] ? themeResults[0].result : null;
      if (themeData && themeData.hasCustomTheme) {
        themeWarning.classList.remove('hidden');
      }
    } catch (e) {
      // Ignored if cannot inspect
    }
  } else {
    pageTitlePreview.textContent = activeTab.title || 'Active Tab';
  }

  btnConvert.addEventListener('click', async () => {
    btnConvert.disabled = true;
    btnText.textContent = 'Preparing Preview...';
    hideStatus();

    try {
      const recognizedTitle = (activeTab.title || '').trim();

      // Execute converter directly in active tab context
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: executeInPlaceCanvasPrint,
        args: [{
          includeTitle: false,
          preserveColors: true,
          suggestedTitle: recognizedTitle
        }]
      });

      const response = results && results[0] ? results[0].result : null;
      if (response && response.error) {
        showStatus(response.error, 'error');
      } else {
        showStatus('Preview opened. Choose "Save as PDF" to save.', 'info');
      }
    } catch (err) {
      console.error(err);
      showStatus('Error: ' + (err.message || 'Could not process page.'), 'error');
    } finally {
      btnConvert.disabled = false;
      btnText.textContent = 'View PDF';
    }
  });

  function showStatus(text, type = 'info') {
    statusMsg.textContent = text;
    statusMsg.className = `status-msg ${type}`;
  }

  function hideStatus() {
    statusMsg.className = 'status-msg hidden';
  }
});

/**
 * Injected check to see if BetterCanvas or custom dark/color themes are active
 */
function detectCanvasTheming() {
  try {
    // 1. Direct BetterCanvas markers (extension injects custom classes/attributes)
    const hasBetterCanvas = !!(
      document.querySelector('[id*="bettercanvas"], [class*="bettercanvas"], [data-bettercanvas]') ||
      document.documentElement.getAttribute('data-theme') ||
      document.body.classList.contains('dark-mode') ||
      document.documentElement.classList.contains('dark') ||
      document.getElementById('bc-dark-mode')
    );

    // 2. Computed background check on body or main content container
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const contentEl = document.querySelector('.user_content, #content, main');
    const contentBg = contentEl ? window.getComputedStyle(contentEl).backgroundColor : 'rgba(0, 0, 0, 0)';

    // Standard Canvas is white (rgb(255, 255, 255)) or transparent rgba(0, 0, 0, 0)
    function isNonStandardColor(rgbStr) {
      if (!rgbStr || rgbStr === 'transparent' || rgbStr === 'rgba(0, 0, 0, 0)') return false;
      const match = rgbStr.match(/\d+/g);
      if (match && match.length >= 3) {
        const r = parseInt(match[0], 10);
        const g = parseInt(match[1], 10);
        const b = parseInt(match[2], 10);
        // Non-standard if it's noticeably dark or tinted (not standard near-white > 248)
        if (r < 240 || g < 240 || b < 240) {
          return true;
        }
      }
      return false;
    }

    const hasCustomBg = isNonStandardColor(bodyBg) || isNonStandardColor(contentBg);

    return {
      hasCustomTheme: hasBetterCanvas || hasCustomBg
    };
  } catch (e) {
    return { hasCustomTheme: false };
  }
}

/**
 * Executes directly inside the active Canvas tab.
 * Automatically performs behind-the-scenes preloading:
 * 1. Un-lazy-loads images (swaps data-src/data-original-src to src, removes loading="lazy").
 * 2. Unrolls lazy-loading IntersectionObservers by performing an instantaneous virtual DOM scroll.
 * 3. Waits for img.decode() on all images so no placeholder boxes or blanks exist in the PDF.
 * 4. Preserves 100% of the live DOM, computed styles, text selection, and triggers window.print().
 */
async function executeInPlaceCanvasPrint(options) {
  try {
    const targetSelectors = [
      '.user_content',
      '#wiki_page_show .show-content',
      '#content .user_content',
      'article.user_content',
      '#content',
      'main',
      '#main'
    ];

    let contentEl = null;
    for (const selector of targetSelectors) {
      const match = document.querySelector(selector);
      if (match && match.innerText.trim().length > 0) {
        contentEl = match;
        break;
      }
    }

    if (!contentEl) {
      return { error: 'Could not find Canvas page content on this tab.' };
    }

    // Save initial scroll position
    const initialScrollY = window.scrollY;

    // --- MAGIC PRELOADER STEP 1: Force lazy image attributes to eager ---
    const allImages = Array.from(contentEl.querySelectorAll('img'));
    allImages.forEach(img => {
      img.setAttribute('loading', 'eager');
      img.removeAttribute('loading');

      // Unpack Canvas / WordPress / LazyLoad dataset properties
      const lazySrc = img.getAttribute('data-src') || 
                      img.getAttribute('data-original') || 
                      img.getAttribute('data-original-src') || 
                      img.getAttribute('data-lazy-src') ||
                      img.getAttribute('data-url');
      if (lazySrc && (!img.src || img.src.includes('data:image/svg') || img.src.includes('blank.gif'))) {
        img.src = lazySrc;
      }

      const lazySrcSet = img.getAttribute('data-srcset');
      if (lazySrcSet) {
        img.srcset = lazySrcSet;
      }
    });

    // --- MAGIC PRELOADER STEP 2: Rapid virtual viewport scroll to trigger lazy-load IntersectionObservers ---
    const scrollStep = Math.max(window.innerHeight * 0.8, 500);
    const maxScroll = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      contentEl.scrollHeight
    );

    for (let pos = 0; pos < maxScroll; pos += scrollStep) {
      window.scrollTo(0, pos);
      await new Promise(r => setTimeout(r, 20));
    }
    // Scroll to very bottom to trigger end-of-page triggers
    window.scrollTo(0, maxScroll);
    await new Promise(r => setTimeout(r, 60));

    // Restore user scroll position
    window.scrollTo(0, initialScrollY);

    // --- MAGIC PRELOADER STEP 3: Ensure all images are decoded and rendered ---
    const pendingDecodes = allImages.map(img => {
      if (img.complete && img.naturalWidth !== 0) {
        return Promise.resolve();
      }
      if (img.decode) {
        return img.decode().catch(() => Promise.resolve());
      }
      return new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 1500); // safety fallback
      });
    });

    // Wait for all decodes or timeout after 3s max
    await Promise.race([
      Promise.all(pendingDecodes),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);

    // Helper: sanitize title into a clean OS filename (Windows, Mac, Linux forbid : / \ * ? " < > |)
    function sanitizeForFilename(name) {
      if (!name) return 'Canvas Document';
      return name
        .replace(/[:]/g, ' - ')
        .replace(/[/\\*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/-{2,}/g, '-')
        .trim()
        .replace(/^[\s.-]+|[\s.-]+$/g, '') || 'Canvas Document';
    }

    // Determine document title for PDF name - prioritize the tab name recognized by the extension!
    let rawTitle = (options && options.suggestedTitle) || '';
    if (!rawTitle) {
      const titleCandidates = [
        document.querySelector('.page-title'),
        document.querySelector('h1.title'),
        document.querySelector('h1'),
        document.querySelector('#breadcrumbs li:last-child')
      ];
      for (const cand of titleCandidates) {
        if (cand && cand.textContent.trim()) {
          rawTitle = cand.textContent.trim();
          break;
        }
      }
    }
    if (!rawTitle) {
      rawTitle = document.title || 'Canvas Document';
    }

    const cleanPdfName = sanitizeForFilename(rawTitle);

    // Set document title and <title> tag temporarily so Chrome's print dialog names the PDF file cleanly
    const originalDocumentTitle = document.title;
    let titleElement = document.querySelector('title');
    if (!titleElement) {
      titleElement = document.createElement('title');
      document.head.appendChild(titleElement);
    }
    const originalTitleTagContent = titleElement.textContent;
    document.title = cleanPdfName;
    titleElement.textContent = cleanPdfName;

    // Expand all details elements so hidden content isn't dropped
    const closedDetails = Array.from(contentEl.querySelectorAll('details:not([open])'));
    closedDetails.forEach(d => d.setAttribute('open', ''));

    // Tag the target container with a unique marker class
    const PRINT_TARGET_CLASS = '__canvas_pdf_target__';
    contentEl.classList.add(PRINT_TARGET_CLASS);

    // Tag all parents of contentEl so they can remain visible in print tree
    const targetAncestors = [];
    let curr = contentEl.parentElement;
    while (curr && curr !== document.documentElement) {
      curr.classList.add('__canvas_pdf_ancestor__');
      targetAncestors.push(curr);
      curr = curr.parentElement;
    }

    // --- MAGIC PRELOADER STEP 4: Intelligent Semantic & Layout Recognition ---
    // Analyzes live DOM & computed styles to identify headings, dividers, lead-ins,
    // tables, callout cards, and lists even when non-standard tags (like <p>, <div>, <span>) are used.
    function detectAndTagPrintElements(rootEl) {
      const tagged = [];

      function addClass(el, className) {
        if (!el || !el.classList) return;
        el.classList.add(className);
        tagged.push({ el, className });
      }

      // Base font size for relative scale comparisons
      const baseStyle = window.getComputedStyle(rootEl);
      const baseFontSize = parseFloat(baseStyle.fontSize) || 16;

      function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }

      // Matches bullet points, dashes, letters/numbers like "1.", "a)", "•", etc.
      const bulletRegex = /^[\s\u200B]*([•\-\*–—\u2022\u25E6\u25AA]|(\d+|[a-zA-Z])[\.\)])\s+/;

      const allDescendants = Array.from(rootEl.querySelectorAll('*'));

      // --- PASS 1: Identify Empty Spacers (<p>&nbsp;</p>, <p><br></p>) ---
      allDescendants.forEach(el => {
        if (el.tagName === 'P' || el.tagName === 'DIV') {
          const text = el.textContent ? el.textContent.replace(/\u00a0/g, ' ').trim() : '';
          if (text.length === 0 && el.querySelectorAll('img, svg, iframe, canvas, table').length === 0) {
            addClass(el, '__canvas_pdf_empty_spacer__');
          }
        }
      });

      // Helper: connect heading / divider to following content so they never break apart
      function markNextSiblingConnection(headingEl) {
        let next = headingEl.nextElementSibling;
        while (next && next.classList.contains('__canvas_pdf_empty_spacer__')) {
          next = next.nextElementSibling;
        }
        if (!next) return;

        if (next.tagName === 'HR' || next.classList.contains('divider')) {
          addClass(next, '__canvas_pdf_heading_divider__');
          let afterHr = next.nextElementSibling;
          while (afterHr && afterHr.classList.contains('__canvas_pdf_empty_spacer__')) {
            afterHr = afterHr.nextElementSibling;
          }
          if (afterHr) {
            addClass(afterHr, '__canvas_pdf_follow_heading__');
          }
        } else {
          addClass(next, '__canvas_pdf_follow_heading__');
        }
      }

      // --- PASS 2: Headings and Pseudo-Headings ---
      allDescendants.forEach(el => {
        if (!isVisible(el)) return;
        const tag = el.tagName;

        // 1. Explicit HTML headings
        if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag) || el.getAttribute('role') === 'heading') {
          addClass(el, '__canvas_pdf_heading__');
          markNextSiblingConnection(el);
          return;
        }

        // 2. Pseudo-headings (<p>, <div>, <header>, <span>)
        if (tag === 'P' || tag === 'DIV' || tag === 'HEADER' || (tag === 'SPAN' && el.parentElement && el.parentElement.children.length === 1)) {
          const rawText = el.innerText || el.textContent || '';
          const text = rawText.replace(/\u00a0/g, ' ').trim();
          if (!text || text.length > 140) return;

          if (el.classList.contains('__canvas_pdf_empty_spacer__')) return;
          if (bulletRegex.test(text)) return; // list item, not heading

          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize) || baseFontSize;
          const fontWeight = parseInt(style.fontWeight, 10) || (style.fontWeight === 'bold' ? 700 : 400);
          const hasBottomBorder = style.borderBottomStyle !== 'none' && parseFloat(style.borderBottomWidth) > 0;
          const hasUnderline = (style.textDecorationLine && style.textDecorationLine.includes('underline')) ||
                               (style.textDecoration && style.textDecoration.includes('underline'));

          const nextEl = el.nextElementSibling;
          const nextIsHr = nextEl && (nextEl.tagName === 'HR' || nextEl.classList.contains('divider'));

          // Look for nested bold/strong text
          const strongChild = el.querySelector('strong, b, [style*="font-weight"]');
          const strongText = strongChild ? (strongChild.innerText || strongChild.textContent || '').trim() : '';
          const isMostlyBold = strongText.length > 0 && strongText.length >= text.length * 0.75;

          const className = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : '';
          const hasHeadingClass = /(title|heading|header|subtitle|subject)/.test(className) && !/(wrapper|container|body|content|panel)/.test(className);

          const isLargeFont = fontSize >= baseFontSize * 1.15;
          const noTerminalPeriod = !/[.!?]$/.test(text) || text.endsWith(':');
          const isBoldAndShort = (fontWeight >= 600 || isMostlyBold) && text.length <= 100 && noTerminalPeriod;
          const hasDividerOrBorder = hasBottomBorder || hasUnderline || nextIsHr;

          // Classification conditions for visual heading
          if ((isLargeFont && (fontWeight >= 500 || hasDividerOrBorder || text.length <= 80)) ||
              (isBoldAndShort && (isLargeFont || hasDividerOrBorder || hasHeadingClass || text.length <= 60)) ||
              (hasHeadingClass && isBoldAndShort) ||
              (nextIsHr && (fontWeight >= 500 || isLargeFont || text.length <= 80))) {
            addClass(el, '__canvas_pdf_heading__');
            markNextSiblingConnection(el);
            return;
          }

          // 3. Lead-in text (e.g. "By the end of the course, you should be able to:")
          if (text.endsWith(':') && text.length <= 160) {
            if (nextEl && (['UL', 'OL', 'TABLE', 'BLOCKQUOTE'].includes(nextEl.tagName) ||
                           nextEl.classList.contains('ic-Table-wrapper') ||
                           bulletRegex.test(nextEl.textContent || ''))) {
              addClass(el, '__canvas_pdf_lead_in__');
              markNextSiblingConnection(el);
              return;
            }
          }
        }
      });

      // --- PASS 3: Tables and Table Wrappers ---
      const tables = Array.from(rootEl.querySelectorAll('table'));
      tables.forEach(table => {
        const rowCount = table.rows ? table.rows.length : table.querySelectorAll('tr').length;
        const height = table.offsetHeight || (rowCount * 35);

        // Keep moderate tables intact on a single page
        if (rowCount <= 16 || height <= 650) {
          addClass(table, '__canvas_pdf_keep_together__');
        }

        const thead = table.querySelector('thead');
        if (thead) {
          addClass(thead, '__canvas_pdf_table_header__');
        }

        // Ensure parent scroll/responsive wrapper doesn't clip or fragment awkwardly
        let parent = table.parentElement;
        if (parent && parent !== rootEl) {
          const pStyle = window.getComputedStyle(parent);
          if (pStyle.overflowX === 'auto' || pStyle.overflowX === 'scroll' || pStyle.overflow === 'hidden' || parent.classList.contains('ic-Table-wrapper')) {
            addClass(parent, '__canvas_pdf_table_wrapper__');
            if (rowCount <= 16 || height <= 650) {
              addClass(parent, '__canvas_pdf_keep_together__');
            }
          }
        }
      });

      // --- PASS 4: Lists & Pseudo-Lists ---
      const lists = Array.from(rootEl.querySelectorAll('ul, ol'));
      lists.forEach(list => {
        const items = Array.from(list.children).filter(c => c.tagName === 'LI');
        if (items.length <= 4) {
          addClass(list, '__canvas_pdf_keep_together__');
        }
        if (items.length >= 2) {
          addClass(items[0], '__canvas_pdf_list_first__');
          addClass(items[items.length - 1], '__canvas_pdf_list_last__');
        }
      });

      // Group consecutive paragraphs/divs acting as custom bullet points
      const blockElements = Array.from(rootEl.querySelectorAll('p, div'));
      let currentBulletGroup = [];

      function flushBulletGroup() {
        if (currentBulletGroup.length >= 2) {
          addClass(currentBulletGroup[0], '__canvas_pdf_list_first__');
          addClass(currentBulletGroup[currentBulletGroup.length - 1], '__canvas_pdf_list_last__');
          if (currentBulletGroup.length <= 4) {
            currentBulletGroup.forEach(el => addClass(el, '__canvas_pdf_keep_together__'));
          }
        }
        currentBulletGroup = [];
      }

      blockElements.forEach(el => {
        if (el.tagName !== 'P' && el.tagName !== 'DIV') return;
        if (el.classList.contains('__canvas_pdf_empty_spacer__')) return;
        const text = (el.textContent || '').trim();
        if (bulletRegex.test(text) && text.length < 300) {
          addClass(el, '__canvas_pdf_pseudo_list_item__');
          currentBulletGroup.push(el);
        } else {
          flushBulletGroup();
        }
      });
      flushBulletGroup();

      // --- PASS 5: Cards, Callouts, Alerts, Banners, and Blockquotes ---
      const potentialCards = Array.from(rootEl.querySelectorAll('div, blockquote, aside, section'));
      potentialCards.forEach(card => {
        if (card === rootEl || card.classList.contains('__canvas_pdf_empty_spacer__')) return;
        const height = card.offsetHeight;
        if (height > 650 || height < 30) return;

        const style = window.getComputedStyle(card);
        const hasBg = style.backgroundColor &&
                      style.backgroundColor !== 'transparent' &&
                      style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                      style.backgroundColor !== 'rgb(255, 255, 255)';
        const hasLeftBorder = style.borderLeftStyle !== 'none' && parseFloat(style.borderLeftWidth) >= 3;
        const hasBorder = style.borderStyle !== 'none' && parseFloat(style.borderWidth) >= 1;
        const className = card.className && typeof card.className === 'string' ? card.className.toLowerCase() : '';
        const isCardClass = /(card|alert|callout|box|banner|note|panel|well|highlight)/.test(className);

        if (card.tagName === 'BLOCKQUOTE' || hasBg || hasLeftBorder || (hasBorder && isCardClass)) {
          addClass(card, '__canvas_pdf_keep_together__');
        }
      });

      return tagged;
    }

    const taggedElements = detectAndTagPrintElements(contentEl);

    // Create and attach dedicated @media print stylesheet
    const styleId = '__canvas_to_pdf_in_place_styles__';
    let styleTag = document.getElementById(styleId);
    if (styleTag) styleTag.remove();

    styleTag = document.createElement('style');
    styleTag.id = styleId;
    styleTag.textContent = `
      @media print {
        @page {
          size: auto;
          margin: 14mm 16mm 14mm 16mm;
        }

        /* Force color preservation across all elements */
        *, *:before, *:after {
          box-sizing: border-box !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
          color-adjust: exact !important;
        }

        /* Hide everything by default */
        body * {
          visibility: hidden !important;
        }

        /* Keep ancestors layout neutral so target isn't clipped or offset */
        html, body {
          background: #ffffff !important;
          margin: 0 !important;
          padding: 0 !important;
          height: auto !important;
          min-height: auto !important;
          overflow: visible !important;
        }

        .__canvas_pdf_ancestor__ {
          visibility: visible !important;
          position: static !important;
          margin: 0 !important;
          padding: 0 !important;
          border: none !important;
          transform: none !important;
          overflow: visible !important;
          float: none !important;
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
        }

        /* Show the target and all its children */
        .${PRINT_TARGET_CLASS}, .${PRINT_TARGET_CLASS} * {
          visibility: visible !important;
        }

        .${PRINT_TARGET_CLASS} {
          position: relative !important;
          left: 0 !important;
          top: 0 !important;
          width: 100% !important;
          max-width: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: visible !important;
        }

        /* Hide Canvas UI elements that might reside inside or around the container */
        #breadcrumbs,
        .al-dropdown__container,
        .admin-links,
        .page-action-list,
        .header-bar,
        .header-bar-right,
        .course-title,
        button,
        .ui-dialog,
        #section-tabs,
        #left-side,
        #right-side,
        #header,
        .ic-app-header,
        .ic-app-nav-toggle-and-crumbs {
          display: none !important;
          visibility: hidden !important;
        }

        /* Prevent single-line orphans and widows in typography */
        p, div, li, blockquote {
          orphans: 3 !important;
          widows: 3 !important;
        }

        /* Headings & Pseudo-Headings (detected regardless of HTML tags) */
        h1, h2, h3, h4, h5, h6,
        [role="heading"],
        .__canvas_pdf_heading__ {
          page-break-after: avoid !important;
          break-after: avoid !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        /* Horizontal rules / dividers attached to headings */
        .__canvas_pdf_heading_divider__ {
          page-break-after: avoid !important;
          break-after: avoid !important;
          page-break-before: avoid !important;
          break-before: avoid !important;
        }

        /* Lead-in sentences ending in colons (e.g. "By the end of the course, you should be able to:") */
        .__canvas_pdf_lead_in__ {
          page-break-after: avoid !important;
          break-after: avoid !important;
        }

        /* Element directly following a heading or divider must stay connected */
        .__canvas_pdf_follow_heading__ {
          page-break-before: avoid !important;
          break-before: avoid !important;
        }

        /* Self-contained blocks (cards, banners, note boxes, small tables, small lists, images) */
        .__canvas_pdf_keep_together__,
        img, svg, figure, canvas, pre, code, blockquote {
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        /* Figures & captions stay together */
        figure, figcaption {
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }
        figcaption {
          page-break-before: avoid !important;
          break-before: avoid !important;
        }

        /* Tables & Table Containers */
        table {
          width: 100% !important;
          border-collapse: collapse !important;
        }

        table, tbody, tfoot, thead, .__canvas_pdf_table_wrapper__ {
          overflow: visible !important;
          height: auto !important;
          max-height: none !important;
        }

        thead, .__canvas_pdf_table_header__ {
          display: table-header-group !important;
          page-break-after: avoid !important;
          break-after: avoid !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        thead tr, tr:first-child {
          page-break-after: avoid !important;
          break-after: avoid !important;
        }

        tbody tr:first-child, tr:nth-child(2) {
          page-break-before: avoid !important;
          break-before: avoid !important;
        }

        tr, th, td {
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        /* Lists & Bullet items (semantic and pseudo) */
        li, .__canvas_pdf_pseudo_list_item__ {
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        li:first-child, .__canvas_pdf_list_first__ {
          page-break-after: avoid !important;
          break-after: avoid !important;
        }

        li:last-child, .__canvas_pdf_list_last__ {
          page-break-before: avoid !important;
          break-before: avoid !important;
        }

        /* Allow large generic sections and articles to split naturally */
        section, article {
          page-break-inside: auto !important;
          break-inside: auto !important;
        }

        /* Hide empty spacer paragraphs created by repetitive Enter key in Canvas */
        .__canvas_pdf_empty_spacer__ {
          display: none !important;
        }

        img {
          max-width: 100% !important;
          height: auto !important;
        }
      }
    `;
    document.head.appendChild(styleTag);

    // Cleanup handler called after print dialog finishes (either saved or canceled)
    const cleanup = () => {
      document.title = originalDocumentTitle;
      if (titleElement) titleElement.textContent = originalTitleTagContent;
      contentEl.classList.remove(PRINT_TARGET_CLASS);
      targetAncestors.forEach(a => a.classList.remove('__canvas_pdf_ancestor__'));
      closedDetails.forEach(d => d.removeAttribute('open'));

      if (taggedElements && taggedElements.length) {
        taggedElements.forEach(({ el, className }) => {
          try {
            if (el && el.classList) {
              el.classList.remove(className);
            }
          } catch (e) {}
        });
      }

      if (styleTag) styleTag.remove();
      window.removeEventListener('afterprint', cleanup);
    };

    window.addEventListener('afterprint', cleanup, { once: true });

    // Trigger print dialog
    window.print();

    return { success: true, title: cleanPdfName };
  } catch (err) {
    return { error: err.toString() };
  }
}

