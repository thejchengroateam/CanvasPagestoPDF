// Popup script: handles user trigger and coordinates page extraction
document.addEventListener('DOMContentLoaded', async () => {
  const pageTitlePreview = document.getElementById('page-title-preview');
  const btnConvert = document.getElementById('btn-convert');
  const btnText = document.getElementById('btn-text');
  const statusMsg = document.getElementById('status-msg');
  const themeWarning = document.getElementById('theme-warning');
  const btnOpenInfo = document.getElementById('btn-open-info');

  const optFrontCover = document.getElementById('opt-front-cover');
  const optToc = document.getElementById('opt-toc');
  const optCompact = document.getElementById('opt-compact');
  const optPageNumbers = document.getElementById('opt-page-numbers');
  const pageNumOptions = document.getElementById('page-num-options');

  // Load saved preferences from chrome.storage.sync/local with localStorage fallback
  async function loadSettings() {
    let settings = {};
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      try {
        settings = await chrome.storage.sync.get([
          'optFrontCover',
          'optToc',
          'optCompact',
          'optPageNumbers',
          'pageNumPos'
        ]);
      } catch (e) {
        console.warn('Storage sync error, falling back to local/localStorage', e);
      }
    }
    
    // Check local storage if sync didn't find anything
    if (!settings || Object.keys(settings).length === 0) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
          settings = await chrome.storage.local.get([
            'optFrontCover',
            'optToc',
            'optCompact',
            'optPageNumbers',
            'pageNumPos'
          ]);
        } catch (e) {}
      }
    }

    // localStorage fallback
    if (!settings || Object.keys(settings).length === 0) {
      try {
        const raw = localStorage.getItem('canvas_to_pdf_settings');
        if (raw) settings = JSON.parse(raw);
      } catch (e) {}
    }

    if (settings) {
      if (typeof settings.optFrontCover === 'boolean') optFrontCover.checked = settings.optFrontCover;
      if (typeof settings.optToc === 'boolean') optToc.checked = settings.optToc;
      if (typeof settings.optCompact === 'boolean') optCompact.checked = settings.optCompact;
      if (typeof settings.optPageNumbers === 'boolean') {
        optPageNumbers.checked = settings.optPageNumbers;
        pageNumOptions.classList.toggle('hidden', !optPageNumbers.checked);
      }
      if (settings.pageNumPos) {
        const radio = document.querySelector(`input[name="page-num-pos"][value="${settings.pageNumPos}"]`);
        if (radio) radio.checked = true;
      }
    }
  }

  function saveSettings() {
    const selectedPos = document.querySelector('input[name="page-num-pos"]:checked')?.value || 'bottom-center';
    const payload = {
      optFrontCover: optFrontCover.checked,
      optToc: optToc.checked,
      optCompact: optCompact.checked,
      optPageNumbers: optPageNumbers.checked,
      pageNumPos: selectedPos
    };

    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.sync) {
        chrome.storage.sync.set(payload).catch(() => {});
      }
      if (chrome.storage.local) {
        chrome.storage.local.set(payload).catch(() => {});
      }
    }
    try {
      localStorage.setItem('canvas_to_pdf_settings', JSON.stringify(payload));
    } catch (e) {}
  }

  await loadSettings();

  // Attach change listeners to save state immediately
  optPageNumbers.addEventListener('change', () => {
    pageNumOptions.classList.toggle('hidden', !optPageNumbers.checked);
    saveSettings();
  });

  optFrontCover.addEventListener('change', saveSettings);
  optToc.addEventListener('change', saveSettings);
  optCompact.addEventListener('change', saveSettings);
  document.querySelectorAll('input[name="page-num-pos"]').forEach(radio => {
    radio.addEventListener('change', saveSettings);
  });

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
    pageTitlePreview.title = activeTab.title || 'Canvas Page Ready';
    
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
    pageTitlePreview.title = activeTab.title || 'Active Tab';
  }

  btnConvert.addEventListener('click', async () => {
    btnConvert.disabled = true;
    btnText.textContent = 'Preparing PDF...';
    hideStatus();

    try {
      const recognizedTitle = (activeTab.title || '').trim();
      const selectedPos = document.querySelector('input[name="page-num-pos"]:checked')?.value || 'bottom-center';

      // Re-save settings right before execution
      saveSettings();

      // Read local KaTeX files to inject into tab
      let katexJs = '';
      let copyTexJs = '';
      let katexCss = '';

      try {
        const [jsResp, copyResp, cssResp] = await Promise.all([
          fetch(chrome.runtime.getURL('lib/katex.min.js')),
          fetch(chrome.runtime.getURL('lib/copy-tex.min.js')),
          fetch(chrome.runtime.getURL('lib/katex.min.css'))
        ]);
        katexJs = await jsResp.text();
        copyTexJs = await copyResp.text();
        let rawCss = await cssResp.text();
        
        // Rewrite relative fonts path in katex.min.css to chrome-extension:// URL
        const fontsBaseUrl = chrome.runtime.getURL('lib/fonts/');
        katexCss = rawCss.replace(/url\(fonts\//g, `url(${fontsBaseUrl}`);
      } catch (libErr) {
        console.warn('Could not read KaTeX assets from extension package:', libErr);
      }

      // Execute converter directly in active tab context
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: executeInPlaceCanvasPrint,
        args: [{
          includeTitle: false,
          preserveColors: true,
          suggestedTitle: recognizedTitle,
          frontCover: optFrontCover.checked,
          tableOfContents: optToc.checked,
          compactLayout: optCompact.checked,
          latexLayer: true, // always enabled
          katexJsCode: katexJs,
          copyTexJsCode: copyTexJs,
          katexCssCode: katexCss,
          pageNumbers: optPageNumbers.checked,
          pageNumberPos: selectedPos
        }]
      });

      const response = results && results[0] ? results[0].result : null;
      if (response && response.error) {
        showStatus(response.error, 'error');
      } else {
        showStatus('Print preview opened. Select "Save as PDF".', 'info');
      }
    } catch (err) {
      console.error(err);
      showStatus('Error: ' + (err.message || 'Could not process page.'), 'error');
    } finally {
      btnConvert.disabled = false;
      btnText.textContent = 'Generate PDF';
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
    const hasBetterCanvas = !!(
      document.querySelector('[id*="bettercanvas"], [class*="bettercanvas"], [data-bettercanvas]') ||
      document.documentElement.getAttribute('data-theme') ||
      document.body.classList.contains('dark-mode') ||
      document.documentElement.classList.contains('dark') ||
      document.getElementById('bc-dark-mode')
    );

    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const contentEl = document.querySelector('.user_content, #content, main');
    const contentBg = contentEl ? window.getComputedStyle(contentEl).backgroundColor : 'rgba(0, 0, 0, 0)';

    function isNonStandardColor(rgbStr) {
      if (!rgbStr || rgbStr === 'transparent' || rgbStr === 'rgba(0, 0, 0, 0)') return false;
      const match = rgbStr.match(/\d+/g);
      if (match && match.length >= 3) {
        const r = parseInt(match[0], 10);
        const g = parseInt(match[1], 10);
        const b = parseInt(match[2], 10);
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
 */
async function executeInPlaceCanvasPrint(options) {
  try {
    const opts = options || {};
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
        setTimeout(resolve, 1500);
      });
    });

    await Promise.race([
      Promise.all(pendingDecodes),
      new Promise(resolve => setTimeout(resolve, 3000))
    ]);

    // Helper: sanitize title into a clean OS filename
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

    // Determine document title and course name
    let rawTitle = opts.suggestedTitle || '';
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

    let courseTitle = '';
    const courseCrumb = document.querySelector('#breadcrumbs li:nth-child(2), .course-title, .ellipsible');
    if (courseCrumb && courseCrumb.textContent.trim()) {
      courseTitle = courseCrumb.textContent.trim();
    }

    const cleanPdfName = sanitizeForFilename(rawTitle);

    // Set document title temporarily
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

    // Tag the target container with unique marker class
    const PRINT_TARGET_CLASS = '__canvas_pdf_target__';
    contentEl.classList.add(PRINT_TARGET_CLASS);

    if (opts.compactLayout) {
      contentEl.classList.add('__canvas_pdf_compact_mode__');
    }

    // Tag all parents of contentEl so they can remain visible in print tree
    const targetAncestors = [];
    let curr = contentEl.parentElement;
    while (curr && curr !== document.documentElement) {
      curr.classList.add('__canvas_pdf_ancestor__');
      targetAncestors.push(curr);
      curr = curr.parentElement;
    }

    // --- STEP 3.5: REVERSE ENGINEER & RENDER FORMULAS WITH NATIVE KATEX ---
    // Instead of leaving formula images that cannot be highlighted or copied,
    // we reverse-engineer the underlying LaTeX code, instantiate KaTeX,
    // and replace each image with beautiful, selectable vector typography.
    // When highlighted in the PDF, copy-tex copies the raw LaTeX source ($...$) directly!
    const replacedMathNodes = [];
    let katexStyleTag = null;

    if (opts.latexLayer !== false && opts.katexJsCode) {
      // 1. Inject KaTeX CSS into active tab
      if (opts.katexCssCode) {
        katexStyleTag = document.createElement('style');
        katexStyleTag.id = '__canvas_katex_styles__';
        katexStyleTag.textContent = opts.katexCssCode;
        document.head.appendChild(katexStyleTag);
      }

      // 2. Instantiate KaTeX runtime inside function closure
      let katexInstance = null;
      try {
        const katexModule = { exports: {} };
        const runKatex = new Function('module', 'exports', opts.katexJsCode);
        runKatex(katexModule, katexModule.exports);
        katexInstance = katexModule.exports || window.katex;
      } catch (kErr) {
        console.warn('Failed to evaluate KaTeX bundle in page context:', kErr);
      }

      // 3. Inject copy-tex script for clipboard LaTeX capture
      if (opts.copyTexJsCode) {
        try {
          const runCopyTex = new Function('katex', opts.copyTexJsCode);
          runCopyTex(katexInstance || window.katex);
        } catch (cErr) {
          console.warn('Failed to evaluate copy-tex in page context:', cErr);
        }
      }

      // Helper: clean and decode raw LaTeX from attributes
      function extractCleanLatex(raw) {
        if (!raw) return '';
        let str = raw.trim();
        str = str.replace(/^LaTeX:\s*/i, '').trim();
        try {
          if (str.includes('%')) {
            str = decodeURIComponent(str);
          }
        } catch (e) {}
        return str.trim();
      }

      if (katexInstance && typeof katexInstance.renderToString === 'function') {
        const equationImages = Array.from(contentEl.querySelectorAll(
          'img.equation_image, img[data-equation-content], img[src*="equation_images"], img[alt*="LaTeX:"]'
        ));

        equationImages.forEach(img => {
          let latex = img.getAttribute('data-equation-content') || '';
          if (!latex && img.alt) {
            latex = extractCleanLatex(img.alt);
          }
          if (!latex && img.title) {
            latex = extractCleanLatex(img.title);
          }
          if (!latex && img.src && img.src.includes('equation_images/')) {
            try {
              const urlParts = img.src.split('equation_images/');
              if (urlParts[1]) {
                latex = extractCleanLatex(urlParts[1].split('?')[0]);
              }
            } catch (e) {}
          }

          if (latex && latex.length > 0) {
            // Determine if block display or inline
            const parentTag = img.parentElement ? img.parentElement.tagName : '';
            const isBlockContainer = parentTag === 'DIV' || parentTag === 'P' || parentTag === 'CENTER';
            const isAloneInBlock = img.parentElement && img.parentElement.children.length === 1 && img.parentElement.textContent.trim().length === 0;
            const isDisplay = isAloneInBlock || (isBlockContainer && (latex.includes('\\begin{') || latex.includes('\\sum') || latex.includes('\\int') || latex.length > 40));

            try {
              const renderedHtml = katexInstance.renderToString(latex, {
                displayMode: isDisplay,
                throwOnError: false
              });

              const span = document.createElement('span');
              span.className = '__canvas_rendered_katex_formula__';
              span.innerHTML = renderedHtml;

              const parent = img.parentNode;
              if (parent) {
                parent.insertBefore(span, img);
                img.style.display = 'none'; // hide original image
                replacedMathNodes.push({ span, originalEl: img, parent });
              }
            } catch (renderErr) {
              console.warn('KaTeX render failed for:', latex, renderErr);
            }
          }
        });

        // Also check MathJax / MathML annotations
        const mathAnnotations = Array.from(contentEl.querySelectorAll('annotation[encoding*="tex"], annotation[encoding*="latex"]'));
        mathAnnotations.forEach(ann => {
          const latex = ann.textContent ? ann.textContent.trim() : '';
          if (latex) {
            const parentMath = ann.closest('math') || ann.closest('.MathJax') || ann.closest('.MathJax_Display') || ann.closest('mjx-container');
            if (parentMath && parentMath.parentNode && !parentMath.classList.contains('__canvas_math_replaced__')) {
              try {
                const isDisplay = parentMath.classList.contains('MathJax_Display') || (parentMath.getAttribute('display') === 'block');
                const renderedHtml = katexInstance.renderToString(latex, {
                  displayMode: isDisplay,
                  throwOnError: false
                });

                const span = document.createElement('span');
                span.className = '__canvas_rendered_katex_formula__';
                span.innerHTML = renderedHtml;

                const parent = parentMath.parentNode;
                parent.insertBefore(span, parentMath);
                parentMath.style.display = 'none';
                parentMath.classList.add('__canvas_math_replaced__');
                replacedMathNodes.push({ span, originalEl: parentMath, parent });
              } catch (e) {}
            }
          }
        });
      }
    }

    // --- MAGIC PRELOADER STEP 4: Intelligent Semantic & Layout Recognition ---
    const detectedHeadings = []; // Collect headings for Table of Contents
    const taggedElements = [];

    function addClass(el, className) {
      if (!el || !el.classList) return;
      el.classList.add(className);
      taggedElements.push({ el, className });
    }

    const baseStyle = window.getComputedStyle(contentEl);
    const baseFontSize = parseFloat(baseStyle.fontSize) || 16;

    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }

    const bulletRegex = /^[\s\u200B]*([•\-\*–—\u2022\u25E6\u25AA]|(\d+|[a-zA-Z])[\.\)])\s+/;
    const allDescendants = Array.from(contentEl.querySelectorAll('*'));

    // PASS 1: Identify Empty Spacers
    allDescendants.forEach(el => {
      if (el.tagName === 'P' || el.tagName === 'DIV') {
        const text = el.textContent ? el.textContent.replace(/\u00a0/g, ' ').trim() : '';
        if (text.length === 0 && el.querySelectorAll('img, svg, iframe, canvas, table, .katex').length === 0) {
          addClass(el, '__canvas_pdf_empty_spacer__');
        }
      }
    });

    // Helper: connect heading / divider to following content
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

    // PASS 2: Headings and Pseudo-Headings
    let headingCounter = 0;
    const modifiedHeadingIds = [];

    allDescendants.forEach(el => {
      if (!isVisible(el)) return;
      if (el.classList.contains('__canvas_rendered_katex_formula__') || el.closest('.katex')) return;
      const tag = el.tagName;

      let isHeading = false;
      let headingLevel = 2;

      if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag) || el.getAttribute('role') === 'heading') {
        isHeading = true;
        if (tag.startsWith('H')) {
          headingLevel = parseInt(tag.charAt(1), 10) || 2;
        } else {
          headingLevel = parseInt(el.getAttribute('aria-level'), 10) || 2;
        }
      } else if (tag === 'P' || tag === 'DIV' || tag === 'HEADER' || (tag === 'SPAN' && el.parentElement && el.parentElement.children.length === 1)) {
        const rawText = el.innerText || el.textContent || '';
        const text = rawText.replace(/\u00a0/g, ' ').trim();
        if (!text || text.length > 140) return;

        if (el.classList.contains('__canvas_pdf_empty_spacer__')) return;
        if (bulletRegex.test(text)) return;

        const style = window.getComputedStyle(el);
        const fontSize = parseFloat(style.fontSize) || baseFontSize;
        const fontWeight = parseInt(style.fontWeight, 10) || (style.fontWeight === 'bold' ? 700 : 400);
        const hasBottomBorder = style.borderBottomStyle !== 'none' && parseFloat(style.borderBottomWidth) > 0;
        const hasUnderline = (style.textDecorationLine && style.textDecorationLine.includes('underline')) ||
                             (style.textDecoration && style.textDecoration.includes('underline'));

        const nextEl = el.nextElementSibling;
        const nextIsHr = nextEl && (nextEl.tagName === 'HR' || nextEl.classList.contains('divider'));

        const strongChild = el.querySelector('strong, b, [style*="font-weight"]');
        const strongText = strongChild ? (strongChild.innerText || strongChild.textContent || '').trim() : '';
        const isMostlyBold = strongText.length > 0 && strongText.length >= text.length * 0.75;

        const className = el.className && typeof el.className === 'string' ? el.className.toLowerCase() : '';
        const hasHeadingClass = /(title|heading|header|subtitle|subject)/.test(className) && !/(wrapper|container|body|content|panel)/.test(className);

        const isLargeFont = fontSize >= baseFontSize * 1.15;
        const noTerminalPeriod = !/[.!?]$/.test(text) || text.endsWith(':');
        const isBoldAndShort = (fontWeight >= 600 || isMostlyBold) && text.length <= 100 && noTerminalPeriod;
        const hasDividerOrBorder = hasBottomBorder || hasUnderline || nextIsHr;

        if ((isLargeFont && (fontWeight >= 500 || hasDividerOrBorder || text.length <= 80)) ||
            (isBoldAndShort && (isLargeFont || hasDividerOrBorder || hasHeadingClass || text.length <= 60)) ||
            (hasHeadingClass && isBoldAndShort) ||
            (nextIsHr && (fontWeight >= 500 || isLargeFont || text.length <= 80))) {
          isHeading = true;
          headingLevel = fontSize >= baseFontSize * 1.3 ? 2 : 3;
        } else if (text.endsWith(':') && text.length <= 160) {
          if (nextEl && (['UL', 'OL', 'TABLE', 'BLOCKQUOTE'].includes(nextEl.tagName) ||
                         nextEl.classList.contains('ic-Table-wrapper') ||
                         bulletRegex.test(nextEl.textContent || ''))) {
            addClass(el, '__canvas_pdf_lead_in__');
            markNextSiblingConnection(el);
            return;
          }
        }
      }

      if (isHeading) {
        addClass(el, '__canvas_pdf_heading__');
        markNextSiblingConnection(el);

        const hText = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (hText.length > 1 && hText.length < 150) {
          headingCounter++;
          const targetId = el.id || `canvas-toc-target-${headingCounter}`;
          if (!el.id) {
            el.id = targetId;
            modifiedHeadingIds.push({ el, originalId: '' });
          }
          detectedHeadings.push({
            id: targetId,
            text: hText,
            level: headingLevel
          });
        }
      }
    });

    // PASS 3: Tables and Table Wrappers
    const tables = Array.from(contentEl.querySelectorAll('table'));
    tables.forEach(table => {
      const rowCount = table.rows ? table.rows.length : table.querySelectorAll('tr').length;
      const height = table.offsetHeight || (rowCount * 35);

      if (rowCount <= 16 || height <= 650) {
        addClass(table, '__canvas_pdf_keep_together__');
      }

      const thead = table.querySelector('thead');
      if (thead) {
        addClass(thead, '__canvas_pdf_table_header__');
      }

      let parent = table.parentElement;
      if (parent && parent !== contentEl) {
        const pStyle = window.getComputedStyle(parent);
        if (pStyle.overflowX === 'auto' || pStyle.overflowX === 'scroll' || pStyle.overflow === 'hidden' || parent.classList.contains('ic-Table-wrapper')) {
          addClass(parent, '__canvas_pdf_table_wrapper__');
          if (rowCount <= 16 || height <= 650) {
            addClass(parent, '__canvas_pdf_keep_together__');
          }
        }
      }
    });

    // PASS 4: Lists & Pseudo-Lists
    const lists = Array.from(contentEl.querySelectorAll('ul, ol'));
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

    const blockElements = Array.from(contentEl.querySelectorAll('p, div'));
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

    // PASS 5: Cards, Callouts, Alerts, Banners, and Blockquotes
    const potentialCards = Array.from(contentEl.querySelectorAll('div, blockquote, aside, section'));
    potentialCards.forEach(card => {
      if (card === contentEl || card.classList.contains('__canvas_pdf_empty_spacer__')) return;
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

    // Optional Table of Contents injection
    let tocEl = null;
    if (opts.tableOfContents && detectedHeadings.length > 0) {
      tocEl = document.createElement('div');
      tocEl.className = '__canvas_pdf_toc_page__';
      
      const tocItemsHtml = detectedHeadings.map(h => {
        const indentClass = h.level > 2 ? '__canvas_pdf_toc_subitem__' : '';
        return `
          <li class="__canvas_pdf_toc_item__ ${indentClass}">
            <a href="#${h.id}" class="__canvas_pdf_toc_link__">
              <span class="__canvas_pdf_toc_title__">${h.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
              <span class="__canvas_pdf_toc_leader__"></span>
            </a>
          </li>
        `;
      }).join('');

      tocEl.innerHTML = `
        <div class="__canvas_pdf_toc_inner__">
          <div class="__canvas_pdf_toc_header__">
            <h2 class="__canvas_pdf_toc_heading__">Table of Contents</h2>
            <div class="__canvas_pdf_toc_line__"></div>
          </div>
          <ul class="__canvas_pdf_toc_list__">
            ${tocItemsHtml}
          </ul>
        </div>
      `;

      contentEl.insertBefore(tocEl, contentEl.firstChild);
    }

    // Optional Front Cover Screen injection
    let coverEl = null;
    if (opts.frontCover) {
      coverEl = document.createElement('div');
      coverEl.className = '__canvas_pdf_cover_page__';
      const formattedDate = new Date().toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      coverEl.innerHTML = `
        <div class="__canvas_pdf_cover_inner__">
          <div class="__canvas_pdf_cover_badge__">Canvas Learning Document</div>
          <h1 class="__canvas_pdf_cover_title__">${rawTitle.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>
          ${courseTitle ? `<div class="__canvas_pdf_cover_course__">${courseTitle.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : ''}
          <div class="__canvas_pdf_cover_meta__">
            <span>Generated: ${formattedDate}</span>
          </div>
        </div>
      `;
      contentEl.insertBefore(coverEl, contentEl.firstChild);
    }

    // CSS @page margin box rules for 6 Positions
    let pageNumberMarginBoxCSS = '';
    if (opts.pageNumbers) {
      const posMap = {
        'top-left': '@top-left { content: counter(page); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 9pt; color: #64748b; }',
        'top-center': '@top-center { content: counter(page); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 9pt; color: #64748b; }',
        'top-right': '@top-right { content: counter(page); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 9pt; color: #64748b; }',
        'bottom-left': '@bottom-left { content: counter(page); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 9pt; color: #64748b; }',
        'bottom-center': '@bottom-center { content: counter(page); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 9pt; color: #64748b; }',
        'bottom-right': '@bottom-right { content: counter(page); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 9pt; color: #64748b; }'
      };
      pageNumberMarginBoxCSS = posMap[opts.pageNumberPos] || posMap['bottom-center'];
    }

    // Attach dedicated @media print stylesheet
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
          ${pageNumberMarginBoxCSS}
        }

        ${opts.frontCover && opts.pageNumbers ? `
        @page :first {
          @top-left { content: none !important; }
          @top-center { content: none !important; }
          @top-right { content: none !important; }
          @bottom-left { content: none !important; }
          @bottom-center { content: none !important; }
          @bottom-right { content: none !important; }
        }
        ` : ''}

        *, *:before, *:after {
          box-sizing: border-box !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
          color-adjust: exact !important;
        }

        body * {
          visibility: hidden !important;
        }

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

        /* Rendered KaTeX Formulas in PDF */
        .__canvas_rendered_katex_formula__ {
          display: inline-block !important;
          vertical-align: middle !important;
          line-height: normal !important;
          user-select: all !important;
          -webkit-user-select: all !important;
        }

        .__canvas_rendered_katex_formula__ .katex-display {
          margin: 0.8em 0 !important;
        }

        /* Front Cover Screen Styling */
        .__canvas_pdf_cover_page__ {
          page-break-after: always !important;
          break-after: page !important;
          height: 90vh !important;
          display: flex !important;
          flex-direction: column !important;
          justify-content: center !important;
          align-items: center !important;
          text-align: center !important;
          padding: 30mm 15mm !important;
          margin: 0 0 20mm 0 !important;
          border-bottom: 2px solid #e2e8f0 !important;
        }

        .__canvas_pdf_cover_inner__ {
          max-width: 85% !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: center !important;
          gap: 16px !important;
        }

        .__canvas_pdf_cover_badge__ {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          font-size: 11pt !important;
          font-weight: 700 !important;
          text-transform: uppercase !important;
          letter-spacing: 2px !important;
          color: #2563eb !important;
          background: #eff6ff !important;
          padding: 6px 14px !important;
          border-radius: 999px !important;
          border: 1px solid #bfdbfe !important;
          display: inline-block !important;
        }

        .__canvas_pdf_cover_title__ {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          font-size: 26pt !important;
          font-weight: 800 !important;
          line-height: 1.25 !important;
          color: #0f172a !important;
          margin: 8px 0 !important;
        }

        .__canvas_pdf_cover_course__ {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          font-size: 14pt !important;
          font-weight: 600 !important;
          color: #475569 !important;
        }

        .__canvas_pdf_cover_meta__ {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          font-size: 10pt !important;
          color: #94a3b8 !important;
          margin-top: 12px !important;
        }

        /* Table of Contents Styling */
        .__canvas_pdf_toc_page__ {
          page-break-after: always !important;
          break-after: page !important;
          margin: 0 0 24mm 0 !important;
          padding: 10mm 4mm 15mm 4mm !important;
          border-bottom: 1px solid #e2e8f0 !important;
        }

        .__canvas_pdf_toc_inner__ {
          width: 100% !important;
        }

        .__canvas_pdf_toc_header__ {
          margin-bottom: 20px !important;
        }

        .__canvas_pdf_toc_heading__ {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          font-size: 18pt !important;
          font-weight: 700 !important;
          color: #0f172a !important;
          margin: 0 0 6px 0 !important;
        }

        .__canvas_pdf_toc_line__ {
          width: 48px !important;
          height: 3px !important;
          background-color: #2563eb !important;
          border-radius: 2px !important;
        }

        .__canvas_pdf_toc_list__ {
          list-style: none !important;
          margin: 0 !important;
          padding: 0 !important;
        }

        .__canvas_pdf_toc_item__ {
          margin: 8px 0 !important;
          padding: 0 !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        .__canvas_pdf_toc_subitem__ {
          margin-left: 20px !important;
          font-size: 0.95em !important;
        }

        .__canvas_pdf_toc_link__ {
          display: flex !important;
          align-items: baseline !important;
          justify-content: space-between !important;
          text-decoration: none !important;
          color: #1e293b !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          font-size: 11pt !important;
          font-weight: 500 !important;
        }

        .__canvas_pdf_toc_link__:hover {
          color: #2563eb !important;
        }

        .__canvas_pdf_toc_title__ {
          flex-shrink: 0 !important;
          max-width: 85% !important;
        }

        .__canvas_pdf_toc_leader__ {
          flex-grow: 1 !important;
          border-bottom: 1px dotted #94a3b8 !important;
          margin: 0 8px 3px 8px !important;
          height: 1px !important;
        }

        /* Compact Layout Compression */
        .__canvas_pdf_compact_mode__ {
          font-size: 0.92em !important;
          line-height: 1.35 !important;
        }

        .__canvas_pdf_compact_mode__ p,
        .__canvas_pdf_compact_mode__ div {
          margin-top: 0.35em !important;
          margin-bottom: 0.35em !important;
        }

        .__canvas_pdf_compact_mode__ h1,
        .__canvas_pdf_compact_mode__ h2,
        .__canvas_pdf_compact_mode__ h3 {
          margin-top: 0.75em !important;
          margin-bottom: 0.35em !important;
        }

        .__canvas_pdf_compact_mode__ li {
          margin-top: 0.15em !important;
          margin-bottom: 0.15em !important;
        }

        .__canvas_pdf_compact_mode__ table td,
        .__canvas_pdf_compact_mode__ table th {
          padding: 4px 6px !important;
          font-size: 0.9em !important;
        }

        .__canvas_pdf_compact_mode__ img {
          max-height: 380px !important;
          width: auto !important;
          object-fit: contain !important;
        }

        /* Hide Canvas UI elements */
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

        /* Headings & Pseudo-Headings */
        h1, h2, h3, h4, h5, h6,
        [role="heading"],
        .__canvas_pdf_heading__ {
          page-break-after: avoid !important;
          break-after: avoid !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        .__canvas_pdf_heading_divider__ {
          page-break-after: avoid !important;
          break-after: avoid !important;
          page-break-before: avoid !important;
          break-before: avoid !important;
        }

        .__canvas_pdf_lead_in__ {
          page-break-after: avoid !important;
          break-after: avoid !important;
        }

        .__canvas_pdf_follow_heading__ {
          page-break-before: avoid !important;
          break-before: avoid !important;
        }

        .__canvas_pdf_keep_together__,
        img, svg, figure, canvas, pre, code, blockquote {
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        figure, figcaption {
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }
        figcaption {
          page-break-before: avoid !important;
          break-before: avoid !important;
        }

        /* Tables */
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

        /* Lists */
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

        section, article {
          page-break-inside: auto !important;
          break-inside: auto !important;
        }

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

    // Cleanup handler called after print dialog finishes
    const cleanup = () => {
      document.title = originalDocumentTitle;
      if (titleElement) titleElement.textContent = originalTitleTagContent;
      contentEl.classList.remove(PRINT_TARGET_CLASS);
      contentEl.classList.remove('__canvas_pdf_compact_mode__');
      if (coverEl) coverEl.remove();
      if (tocEl) tocEl.remove();
      targetAncestors.forEach(a => a.classList.remove('__canvas_pdf_ancestor__'));
      closedDetails.forEach(d => d.removeAttribute('open'));

      // Restore replaced math elements
      if (replacedMathNodes && replacedMathNodes.length) {
        replacedMathNodes.forEach(({ span, originalEl, parent }) => {
          try {
            if (span && span.parentNode) {
              span.remove();
            }
            if (originalEl) {
              originalEl.style.display = '';
              originalEl.classList.remove('__canvas_math_replaced__');
            }
          } catch (e) {}
        });
      }

      if (katexStyleTag) {
        katexStyleTag.remove();
      }

      if (modifiedHeadingIds && modifiedHeadingIds.length) {
        modifiedHeadingIds.forEach(({ el, originalId }) => {
          try {
            if (originalId) {
              el.id = originalId;
            } else {
              el.removeAttribute('id');
            }
          } catch (e) {}
        });
      }

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
