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

      // Canvas forbids eval ('unsafe-eval' is not in its CSP), so the KaTeX
      // runtime cannot be evaluated inside the page. It runs here, in the
      // extension page, and only rendered HTML strings are passed in.
      let katexCss = '';
      try {
        let rawCss = await (await fetch(chrome.runtime.getURL('lib/katex.min.css'))).text();
        // Rewrite relative fonts path in katex.min.css to chrome-extension:// URL
        const fontsBaseUrl = chrome.runtime.getURL('lib/fonts/');
        katexCss = rawCss.replace(/url\(fonts\//g, `url(${fontsBaseUrl}`);
        // Never let an unloaded KaTeX font paint invisible glyphs: with the
        // default ("auto") block period the math can print blank while the
        // font request is still pending.
        katexCss = katexCss.replace(/@font-face\{/g, '@font-face{font-display:swap;');
      } catch (libErr) {
        console.warn('Could not read KaTeX stylesheet from the extension package:', libErr);
      }

      // Pre-render every formula on the page with the popup's KaTeX build.
      let mathHtmlMap = {};
      try {
        const latexList = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: collectEquationLatexFromPage
        }).then(r => (r && r[0] && r[0].result) || []).catch(() => []);

        const katex = window.katex;
        if (latexList.length && !(katex && typeof katex.renderToString === 'function')) {
          console.warn('KaTeX runtime missing in the popup; formulas will stay as images.');
        } else if (katex) {
          latexList.forEach(latex => {
            try {
              mathHtmlMap[latex] = {
                block: katex.renderToString(latex, { displayMode: true, throwOnError: false }),
                inline: katex.renderToString(latex, { displayMode: false, throwOnError: false })
              };
            } catch (e) {}
          });
        }
      } catch (e) {
        console.warn('Could not pre-render formulas:', e);
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
          mathHtmlMap: mathHtmlMap,
          katexCssCode: katexCss,
          pageNumbers: optPageNumbers.checked,
          pageNumberPos: selectedPos
        }]
      });

      const response = results && results[0] ? results[0].result : null;
      if (response && response.error) {
        showStatus(response.error, 'error');
      } else {
        const captured = response && response.label ? ` (${response.label})` : '';
        showStatus(`Print preview opened${captured}. Select "Save as PDF".`, 'info');
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
 * Collects the LaTeX source of every Canvas equation image on the page.
 * Runs in the Canvas tab (native injection, no eval), so it works even when
 * the page CSP forbids 'unsafe-eval'.
 */
function collectEquationLatexFromPage() {
  try {
    function extractCleanLatex(raw) {
      if (!raw) return '';
      let str = raw.trim().replace(/^LaTeX:\s*/i, '').trim();
      try {
        if (str.includes('%')) str = decodeURIComponent(str);
      } catch (e) {}
      return str.trim();
    }

    const nodes = Array.from(document.querySelectorAll(
      'img.equation_image, img[data-equation-content], img[src*="equation_images"], img[alt*="LaTeX:"]'
    ));

    const seen = Object.create(null);
    const result = [];

    const consider = img => {
      let latex = img.getAttribute('data-equation-content') || '';
      if (!latex && img.alt) latex = extractCleanLatex(img.alt);
      if (!latex && img.title) latex = extractCleanLatex(img.title);
      if (!latex && img.src && img.src.includes('equation_images/')) {
        try {
          const parts = img.src.split('equation_images/');
          if (parts[1]) latex = extractCleanLatex(parts[1].split('?')[0]);
        } catch (e) {}
      }
      if (!latex || seen[latex]) return;
      seen[latex] = true;
      result.push(latex);
    };

    nodes.forEach(consider);

    // Shadow-rendered equation images are invisible to document queries.
    Array.from(document.querySelectorAll('*')).forEach(el => {
      if (el.shadowRoot) {
        try {
          Array.from(el.shadowRoot.querySelectorAll(
            'img.equation_image, img[data-equation-content], img[src*="equation_images"], img[alt*="LaTeX:"]'
          )).forEach(consider);
        } catch (e) {}
      }
    });

    return result;
  } catch (e) {
    return [];
  }
}

/**
 * Executes directly inside the active Canvas tab.
 */
async function executeInPlaceCanvasPrint(options) {
  // Nodes injected into the page; always torn down, even on an early failure,
  // so a broken run can never leave a print stylesheet behind.
  const injectedNodes = [];
  const removeInjectedNodes = () => {
    while (injectedNodes.length) {
      const node = injectedNodes.pop();
      try { if (node && node.remove) node.remove(); } catch (e) {}
    }
  };
  let savedDocumentTitle = null;

  try {
    const opts = options || {};
    const targetSelectors = [
      '#assignment_show .description.user_content',
      '#assignment_show .user_content',
      '.assignment-content .user_content',
      '.assignment-description',
      '#wiki_page_show .show-content',
      '#wiki_page_show .user_content',
      '#syllabus .user_content',
      '#content .user_content',
      '.user_content',
      'article.user_content',
      '#assignment_show',
      '#wiki_page_show',
      '#syllabus',
      '#content',
      'main',
      '#main'
    ];

    // A candidate is usable when it actually renders something (text or media).
    function hasRenderableContent(el) {
      if (!el) return false;
      try {
        const rect = el.getBoundingClientRect();
        if (!rect.height && !el.offsetHeight) return false;
        const text = (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').trim();
        if (text.length > 0) return true;
        return !!el.querySelector('img, svg, canvas, video, iframe, table');
      } catch (e) {
        return false;
      }
    }

    let sourceEl = null;
    let sourceSelector = '';
    for (const selector of targetSelectors) {
      const match = document.querySelector(selector);
      if (match && hasRenderableContent(match)) {
        sourceEl = match;
        sourceSelector = selector;
        break;
      }
    }

    if (!sourceEl) {
      return {
        error: 'Could not find any readable Canvas content on this tab. Open the page or assignment you want to save, then try again.'
      };
    }

    // Drop leftovers from an interrupted previous run.
    document.querySelectorAll('.__canvas_pdf_print_host__, #__canvas_to_pdf_in_place_styles__, #__canvas_pdf_host_styles__').forEach(node => {
      try { node.remove(); } catch (e) {}
    });

    // Collected during the run and reported as one line before printing.
    const captureNotes = [];

    function describeSource(selector) {
      if (selector === '#assignment_show') return 'the assignment page';
      if (/assignment_show|assignment-content|assignment-description/.test(selector)) return 'the assignment description';
      if (/wiki_page_show/.test(selector)) return 'the page body';
      if (/syllabus/.test(selector)) return 'the syllabus';
      if (/user_content/.test(selector)) return 'the course content';
      return 'the main page content';
    }

    // Save initial scroll position
    const initialScrollY = window.scrollY;

    // Rapid virtual viewport sweep so the browser resolves lazy-loaded media.
    // This only scrolls the live page back and forth; it never rewrites its DOM.
    try {
      const scrollStep = Math.max(window.innerHeight * 0.8, 500);
      const maxScroll = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        sourceEl.scrollHeight
      );

      for (let pos = 0; pos < maxScroll; pos += scrollStep) {
        window.scrollTo(0, pos);
        await new Promise(r => setTimeout(r, 20));
      }
      window.scrollTo(0, maxScroll);
      await new Promise(r => setTimeout(r, 60));
    } catch (e) {}

    // Restore user scroll position
    window.scrollTo(0, initialScrollY);

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
        document.querySelector('.assignment-title'),
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

    // Rename the tab only; the <title> text is not part of Canvas' layout and
    // is restored in cleanup. It gives Chrome a sensible default file name.
    const originalDocumentTitle = document.title;
    savedDocumentTitle = originalDocumentTitle;
    document.title = cleanPdfName;

    // ---------------------------------------------------------------------
    // Build the print copy in its own document (an offscreen iframe).
    //
    // Two things in Canvas' page must never be touched:
    //   1. its DOM  — assignment pages are React-rendered, and inserting or
    //      re-parenting nodes made the reconciler throw ("Sorry, Something
    //      Broke", blank printout).
    //   2. its layout — the print stylesheet used to hide every body child,
    //      and while the preview was open that collapsed each Canvas React
    //      container to 0x0. Canvas' ResizeObservers fired on the collapse
    //      *and* on the restore when the dialog closed, which is what broke
    //      the page right after printing.
    // Keeping the copy (and its @media print rules) in a separate document
    // means Canvas keeps its screen layout the entire time; the page only
    // gains one transient offscreen iframe.
    // ---------------------------------------------------------------------
    const PRINT_TARGET_CLASS = '__canvas_pdf_target__';
    const FRAME_ID = '__canvas_pdf_print_frame__';

    // Drop leftovers from an interrupted previous run.
    Array.from(document.querySelectorAll(
      '#__canvas_pdf_print_frame__, #__canvas_pdf_print_host__, #__canvas_to_pdf_in_place_styles__, #__canvas_pdf_host_styles__, #__canvas_katex_styles__'
    )).forEach(node => {
      try { node.remove(); } catch (e) {}
    });

    const frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('title', 'Canvas PDF print copy');
    frame.style.cssText = 'position:fixed;top:0;left:-20000px;width:800px;height:1200px;border:0;z-index:-1;pointer-events:none;';
    document.body.appendChild(frame);
    injectedNodes.push(frame);

    const doc = frame.contentDocument;
    const view = frame.contentWindow;
    doc.open();
    doc.write('<!DOCTYPE html><html><head></head><body></body></html>');
    doc.close();

    // Carry the page's theme hooks over (html/body classes, inline style
    // variables, data-attributes) so Canvas CSS resolves the same way.
    ['class', 'style', 'lang', 'dir'].forEach(name => {
      const value = document.documentElement.getAttribute(name);
      if (value !== null) doc.documentElement.setAttribute(name, value);
      const bodyValue = document.body.getAttribute(name);
      if (bodyValue !== null) doc.body.setAttribute(name, bodyValue);
    });
    Array.from(document.documentElement.attributes).forEach(attr => {
      if (attr.name.indexOf('data-') === 0) doc.documentElement.setAttribute(attr.name, attr.value);
    });
    Array.from(document.body.attributes).forEach(attr => {
      if (attr.name.indexOf('data-') === 0) doc.body.setAttribute(attr.name, attr.value);
    });

    // Relative URLs (images, fonts) must resolve exactly like on the page.
    const baseTag = doc.createElement('base');
    baseTag.href = document.baseURI;
    doc.head.appendChild(baseTag);

    // Reuse the page's stylesheets inside the copy's document.
    const styleLoads = [];
    Array.from(document.querySelectorAll('link[rel~="stylesheet"], style')).forEach(node => {
      try {
        if (node.tagName === 'LINK') {
          const href = node.href;
          if (!href) return;
          const link = doc.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          styleLoads.push(new Promise(resolve => {
            link.addEventListener('load', resolve, { once: true });
            link.addEventListener('error', resolve, { once: true });
          }));
          doc.head.appendChild(link);
        } else {
          const style = doc.createElement('style');
          style.textContent = node.textContent;
          doc.head.appendChild(style);
        }
      } catch (e) {}
    });

    // Measurements become meaningful only once the copied CSS has applied.
    await Promise.race([
      Promise.all(styleLoads),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);

    // Clone the content, plus a shallow copy of its ancestor chain so Canvas
    // descendant selectors such as "#assignment_show .user_content" still
    // match in the copy.
    const cloneTarget = sourceEl.cloneNode(true);

    // --- STEP 0: preserve rendered content that cloneNode() cannot copy ---
    //  * <canvas> pixels are not cloned at all, so snapshot the live canvas.
    //  * open shadow roots are not cloned either; fold their rendered children
    //    into the copy so shadow-rendered widgets (math renderers, custom
    //    elements) survive into the PDF.
    let canvasSnapshots = 0;
    let shadowRootsFlattened = 0;

    const snapshotCanvas = (srcCanvas, copyCanvas) => {
      try {
        const dataUrl = srcCanvas.toDataURL('image/png');
        if (!dataUrl || dataUrl.length < 64) return false;
        const replacement = doc.createElement('img');
        replacement.setAttribute('src', dataUrl);
        const w = srcCanvas.clientWidth || srcCanvas.width;
        const h = srcCanvas.clientHeight || srcCanvas.height;
        if (w) replacement.setAttribute('width', String(w));
        if (h) replacement.setAttribute('height', String(h));
        replacement.style.maxWidth = '100%';
        replacement.style.height = 'auto';
        copyCanvas.replaceWith(replacement);
        canvasSnapshots++;
        return true;
      } catch (e) {
        return false;
      }
    };

    (function preserveRenderedContent(srcRoot, copyRoot) {
      const srcChildren = Array.from(srcRoot.children);
      const copyChildren = Array.from(copyRoot.children);
      const shared = Math.min(srcChildren.length, copyChildren.length);

      for (let i = 0; i < shared; i++) {
        const srcEl = srcChildren[i];
        const copyEl = copyChildren[i];

        if (srcEl.tagName === 'CANVAS' && copyEl.tagName === 'CANVAS') {
          snapshotCanvas(srcEl, copyEl);
          continue;
        }

        preserveRenderedContent(srcEl, copyEl);

        if (srcEl.shadowRoot) {
          try {
            const fragment = doc.createDocumentFragment();
            Array.from(srcEl.shadowRoot.childNodes).forEach(node => {
              fragment.appendChild(node.cloneNode(true));
            });
            copyEl.appendChild(fragment);

            // The freshly appended shadow canvases still lack their pixels.
            const shadowCanvases = Array.from(srcEl.shadowRoot.querySelectorAll('canvas'));
            const copiedCanvases = Array.from(copyEl.querySelectorAll('canvas'));
            for (let k = 0; k < shadowCanvases.length && k < copiedCanvases.length; k++) {
              snapshotCanvas(shadowCanvases[k], copiedCanvases[k]);
            }
            shadowRootsFlattened++;
          } catch (e) {}
        }
      }
    })(sourceEl, cloneTarget);

    let outerCopy = cloneTarget;
    let ancestor = sourceEl.parentElement;
    let ancestorGuard = 0;
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement && ancestorGuard < 14) {
      const wrapper = ancestor.cloneNode(false);
      wrapper.classList.add('__canvas_pdf_wrap__');
      if (/^(DIV|MAIN|SECTION|ARTICLE|ASIDE|HEADER|FOOTER|FORM)$/.test(wrapper.tagName)) {
        wrapper.classList.add('__canvas_pdf_wrap_block__');
      }
      wrapper.appendChild(outerCopy);
      outerCopy = wrapper;
      ancestor = ancestor.parentElement;
      ancestorGuard++;
    }

    doc.body.appendChild(outerCopy);

    const contentEl = cloneTarget;
    contentEl.classList.add(PRINT_TARGET_CLASS);

    if (opts.compactLayout) {
      contentEl.classList.add('__canvas_pdf_compact_mode__');
    }

    // Give the copy's document a title too, so "Save as PDF" suggests the
    // clean name rather than the Canvas URL.
    doc.title = cleanPdfName;

    // Keep the copy fully laid out so measurements are accurate.
    const hostStyle = doc.createElement('style');
    hostStyle.textContent = `
      .__canvas_pdf_wrap__, .__canvas_pdf_wrap__ * {
        content-visibility: visible !important;
      }
    `;
    doc.head.appendChild(hostStyle);

    // Bail out with a helpful message instead of printing blank pages.
    const previewText = ((contentEl.innerText || contentEl.textContent) || '').replace(/\u00a0/g, ' ').trim();
    const previewMedia = contentEl.querySelectorAll('img, svg, canvas, video, iframe, table').length;
    if (previewText.length < 15 && previewMedia === 0) {
      removeInjectedNodes();
      return {
        error: 'This page has no readable content to capture. Open a Canvas Page or an assignment that has a description, then try again.'
      };
    }

    // --- STEP 1: resolve lazy media inside the copy ---
    Array.from(contentEl.querySelectorAll('img')).forEach(img => {
      const lazySrc = img.getAttribute('data-src') ||
                      img.getAttribute('data-original') ||
                      img.getAttribute('data-original-src') ||
                      img.getAttribute('data-lazy-src') ||
                      img.getAttribute('data-url');
      const currentSrc = img.getAttribute('src') || '';
      if (lazySrc && (!currentSrc || currentSrc.indexOf('data:image') === 0 || currentSrc.includes('blank.gif'))) {
        img.setAttribute('src', lazySrc);
      }

      const lazySrcSet = img.getAttribute('data-srcset');
      if (lazySrcSet && !img.getAttribute('srcset')) {
        img.setAttribute('srcset', lazySrcSet);
      }

      img.setAttribute('loading', 'eager');
      img.removeAttribute('loading');
    });

    // NOTE: canvases were already replaced by their live pixels in STEP 0 —
    // snapshotting the cloned canvas here would only produce a blank bitmap.

    // --- STEP 2: pull embedded documents inline where possible ---
    // Re-loading an LTI / Studio iframe a second time can re-launch third-party
    // tools (another way Canvas pages blow up), so the copy never re-mounts an
    // iframe. Same-origin frames (the text-entry editor, embedded Canvas
    // content) are copied in place; cross-origin tools become a placeholder.
    function expandSameOriginFrame(frameEl) {
      if (!frameEl || frameEl.tagName !== 'IFRAME') return null;
      let frameDoc = null;
      try { frameDoc = frameEl.contentDocument; } catch (e) { return null; }
      if (!frameDoc || !frameDoc.body) return null;

      let html = '';
      try { html = frameDoc.body.innerHTML || ''; } catch (e) { return null; }
      if (!html || html.length > 400000) return null;

      const text = (frameDoc.body.innerText || frameDoc.body.textContent || '').trim();
      if (!text && !frameDoc.body.querySelector('img, svg, canvas, table')) return null;

      const wrapper = doc.createElement('div');
      wrapper.className = '__canvas_pdf_embed_expanded__';
      wrapper.innerHTML = html;

      Array.from(wrapper.querySelectorAll('script, style, link, meta, noscript')).forEach(n => n.remove());
      // Drop duplicated Canvas chrome if the frame happened to contain a full page.
      Array.from(wrapper.querySelectorAll('#header, #left-side, #right-side, #breadcrumbs, .ic-app-header, .ic-app-nav-toggle-and-crumbs, nav')).forEach(n => n.remove());
      wrapper.style.maxWidth = '100%';
      return wrapper;
    }

    const liveEmbeds = Array.from(sourceEl.querySelectorAll('iframe, object, embed, video'));
    Array.from(contentEl.querySelectorAll('iframe, object, embed, video')).forEach((embed, index) => {
      try {
        const liveEmbed = liveEmbeds[index] || null;
        const rect = (liveEmbed || embed).getBoundingClientRect();
        const label = (embed.getAttribute('title') || embed.getAttribute('aria-label') || 'Embedded content').trim();
        const poster = embed.tagName === 'VIDEO' ? embed.getAttribute('poster') : '';

        let replacement = expandSameOriginFrame(liveEmbed);
        if (replacement && !poster) {
          embed.replaceWith(replacement);
          return;
        }

        if (poster) {
          replacement = doc.createElement('img');
          replacement.setAttribute('src', poster);
        } else {
          replacement = doc.createElement('div');
          replacement.className = '__canvas_pdf_embed_placeholder__';
          replacement.textContent = label + ' (not captured)';
        }
        if (rect && rect.width && !replacement.tagName.match(/^IMG$/)) {
          replacement.style.width = Math.round(rect.width) + 'px';
          replacement.style.height = Math.round(rect.height) + 'px';
        }
        embed.replaceWith(replacement);
      } catch (e) {}
    });

    // --- STEP 3: expand collapsed details so hidden content isn't dropped ---
    Array.from(contentEl.querySelectorAll('details:not([open])')).forEach(d => d.setAttribute('open', ''));

    // --- STEP 4: wait until every image in the copy is decoded ---
    const pendingDecodes = Array.from(contentEl.querySelectorAll('img')).map(img => {
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
      new Promise(resolve => setTimeout(resolve, 4000))
    ]);

    // --- STEP 4.5: rescue images that failed to load inside the copy ---
    // The copy re-requests every image, and hotlink protection, referrer
    // checks or a signed URL that expired can leave an empty box. Fetching the
    // bytes from the page itself (same cookies) and inlining them keeps the
    // figure in the PDF.
    let imagesRescued = 0;
    let imagesStillBroken = 0;
    const failedImages = Array.from(contentEl.querySelectorAll('img')).filter(img => {
      const src = img.getAttribute('src');
      return src && !/^data:/i.test(src) && img.complete && img.naturalWidth === 0;
    });

    for (const img of failedImages.slice(0, 30)) {
      try {
        const src = img.getAttribute('src');
        const response = await fetch(src, { credentials: 'include' });
        if (!response.ok) {
          imagesStillBroken++;
          continue;
        }
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('read failed'));
          reader.readAsDataURL(blob);
        });
        if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) {
          imagesStillBroken++;
          continue;
        }
        img.removeAttribute('srcset');
        img.setAttribute('src', dataUrl);
        imagesRescued++;
        try { if (img.decode) await img.decode(); } catch (e) {}
      } catch (e) {
        imagesStillBroken++;
      }
    }

    // --- STEP 4.6: keep SVG sprite/clip references intact ---
    // <use href="#id">, clip-path/mask/filter/fill="url(#id)" can point at
    // definitions outside the captured subtree. Those definitions would be
    // missing from the copy and the element would render as nothing.
    let svgRefsRestored = 0;
    try {
      const refAttrs = ['href', 'xlink:href', 'clip-path', 'mask', 'filter', 'fill', 'stroke'];
      const knownIds = new Set(Array.from(contentEl.querySelectorAll('[id]')).map(el => el.id));
      let defsHost = null;

      Array.from(contentEl.querySelectorAll('*')).forEach(el => {
        refAttrs.forEach(attr => {
          const value = el.getAttribute(attr);
          if (!value) return;
          const urlMatch = value.match(/^url\(#([^)]+)\)$/);
          const id = urlMatch ? urlMatch[1] : (value.charAt(0) === '#' ? value.slice(1) : '');
          if (!id || knownIds.has(id)) return;

          const source = document.getElementById(id);
          if (!source) return;

          if (!defsHost) {
            defsHost = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
            defsHost.setAttribute('width', '0');
            defsHost.setAttribute('height', '0');
            defsHost.setAttribute('aria-hidden', 'true');
            defsHost.setAttribute('class', '__canvas_pdf_svg_defs__');
            defsHost.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
            contentEl.insertBefore(defsHost, contentEl.firstChild);
          }

          defsHost.appendChild(source.cloneNode(true));
          knownIds.add(id);
          svgRefsRestored++;
        });
      });
    } catch (e) {}

    // --- STEP 5: SWAP FORMULA IMAGES FOR PRE-RENDERED KATEX ---
    // Instead of leaving formula images that cannot be highlighted or copied,
    // we replace each image with typeset vector math. The HTML was rendered by
    // KaTeX in the extension popup, because Canvas' CSP forbids eval and the
    // runtime therefore cannot be instantiated inside the page.
    let katexStyleTag = null;
    let mathImageFound = 0;
    let mathRendered = 0;
    let mathImageKept = 0;

    if (opts.latexLayer !== false) {
      // 1. Inject KaTeX CSS into the copy's document
      if (opts.katexCssCode) {
        katexStyleTag = doc.createElement('style');
        katexStyleTag.id = '__canvas_katex_styles__';
        katexStyleTag.textContent = opts.katexCssCode;
        doc.head.appendChild(katexStyleTag);
      }

      // 2. Formulas were pre-rendered by the extension popup (Canvas' CSP
      //    forbids eval, so KaTeX cannot run inside the page). Only the
      //    resulting HTML strings travel in.
      const mathHtmlMap = (opts.mathHtmlMap && typeof opts.mathHtmlMap === 'object') ? opts.mathHtmlMap : {};

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

      {
        const equationImages = Array.from(contentEl.querySelectorAll(
          'img.equation_image, img[data-equation-content], img[src*="equation_images"], img[alt*="LaTeX:"]'
        ));

        // A typeset formula is only allowed to replace the original image once
        // it demonstrably renders. If the KaTeX markup comes out collapsed or
        // invisible (missing CSS, theme interference, font problems), the image
        // is kept so the formula is never lost from the PDF.
        const isMathRenderVisible = (span) => {
          try {
            const visiblePart = span.querySelector('.katex-html') || span;
            const spanRect = span.getBoundingClientRect();
            const partRect = visiblePart.getBoundingClientRect();
            const cs = view.getComputedStyle(span);
            if (!cs || cs.display === 'none' || cs.visibility !== 'visible') return false;
            if (parseFloat(cs.opacity || '1') < 0.05) return false;
            if (!spanRect || !partRect) return false;
            return spanRect.width > 3 && spanRect.height > 5 && partRect.width > 3 && partRect.height > 5;
          } catch (e) {
            return false;
          }
        };

        const insertTypesetMath = (target, latex, displayMode) => {
          const entry = mathHtmlMap[latex];
          const renderedHtml = entry ? (displayMode ? entry.block : entry.inline) : '';
          if (!renderedHtml) return false;

          const span = doc.createElement('span');
          span.className = '__canvas_rendered_katex_formula__';
          span.innerHTML = renderedHtml;

          const parent = target.parentNode;
          if (!parent) return false;
          parent.insertBefore(span, target);

          if (!isMathRenderVisible(span)) {
            span.remove();
            return false;
          }

          target.style.display = 'none';
          return true;
        };

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

            mathImageFound++;
            try {
              if (insertTypesetMath(img, latex, isDisplay)) {
                mathRendered++;
              } else {
                mathImageKept++;
              }
            } catch (renderErr) {
              mathImageKept++;
              console.warn('KaTeX render failed for:', latex, renderErr);
            }
          }
        });

        // MathJax / MathML sources (e.g. a page that already carries <math>).
        // Skip anything our own KaTeX pass just generated, or it would be
        // rendered a second time inside a clipped MathML container.
        const mathAnnotations = Array.from(contentEl.querySelectorAll('annotation[encoding*="tex"], annotation[encoding*="latex"]'));
        mathAnnotations.forEach(ann => {
          try {
            if (ann.closest('.katex')) return;
            if (ann.closest('.__canvas_rendered_katex_formula__')) return;
          } catch (e) {
            return;
          }

          const latex = ann.textContent ? ann.textContent.trim() : '';
          if (!latex) return;
          // Only typeset when the popup actually pre-rendered this LaTeX;
          // otherwise the native MathML/MathJax output is left untouched.
          if (!mathHtmlMap[latex]) return;

          const parentMath = ann.closest('math') || ann.closest('.MathJax') || ann.closest('.MathJax_Display') || ann.closest('mjx-container');
          if (!parentMath || !parentMath.parentNode) return;
          if (parentMath.classList.contains('__canvas_math_replaced__')) return;

          try {
            const isDisplay = parentMath.classList.contains('MathJax_Display') || (parentMath.getAttribute('display') === 'block');
            if (insertTypesetMath(parentMath, latex, isDisplay)) {
              parentMath.classList.add('__canvas_math_replaced__');
              mathRendered++;
            }
          } catch (e) {}
        });

        const mathNodeCount = contentEl.querySelectorAll('math').length;

        if (mathRendered > 0) {
          captureNotes.push(mathRendered + ' formula image(s) typeset');
        }
        if (mathImageKept > 0) {
          captureNotes.push(mathImageKept + ' formula image(s) kept');
        }
        if (mathRendered === 0 && mathImageFound === 0 && mathNodeCount > 0) {
          captureNotes.push(mathNodeCount + ' MathML formula(s) kept as rendered');
        }

        if (imagesRescued > 0) captureNotes.push(imagesRescued + ' image(s) re-fetched');
        if (imagesStillBroken > 0) captureNotes.push(imagesStillBroken + ' image(s) failed to load');
        if (canvasSnapshots > 0) captureNotes.push(canvasSnapshots + ' canvas(es) snapshotted');
        if (shadowRootsFlattened > 0) captureNotes.push(shadowRootsFlattened + ' shadow root(s) flattened');
        if (svgRefsRestored > 0) captureNotes.push(svgRefsRestored + ' SVG definition(s) restored');
      }
    }

    // --- STEP 6: Intelligent Semantic & Layout Recognition ---
    // Everything below only ever touches the isolated copy, so no bookkeeping
    // arrays are needed to undo it afterwards.
    const detectedHeadings = []; // Collect headings for Table of Contents

    function addClass(el, className) {
      if (!el || !el.classList) return;
      el.classList.add(className);
    }

    const baseStyle = view.getComputedStyle(contentEl);
    const baseFontSize = parseFloat(baseStyle.fontSize) || 16;

    function isVisible(el) {
      if (!el) return false;
      const style = view.getComputedStyle(el);
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

        const style = view.getComputedStyle(el);
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
        const pStyle = view.getComputedStyle(parent);
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

      const style = view.getComputedStyle(card);
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

    // PASS 6: keep a heading/banner attached to the block that follows it.
    // Chromium ignores `break-after: avoid` / `break-before: avoid` (the rules
    // above are best-effort only), which is why a section banner could still
    // end up alone at the bottom of a page. Chromium *does* honour
    // `break-inside: avoid`, so the heading block and the block after it are
    // wrapped into one unit that moves to the next page together.
    // Skipped in compact mode, where saving pages wins over layout polish.
    let headingGroups = 0;
    if (!opts.compactLayout) {
      const MAX_GROUP_HEIGHT = 800; // below a printed page (~950px of content)
      const BLOCK_TAGS = /^(DIV|P|SECTION|ARTICLE|HEADER|ASIDE|BLOCKQUOTE|FIGURE|DL|H[1-6])$/;

      const canGroup = el => {
        if (!el || el.nodeType !== 1) return false;
        if (el.classList.contains('__canvas_pdf_keep_with_next__')) return false;
        if (el.classList.contains('__canvas_pdf_heading__')) return false;
        if (el.classList.contains('__canvas_pdf_empty_spacer__')) return false;
        if (el.classList.contains('__canvas_pdf_toc_page__') || el.classList.contains('__canvas_pdf_cover_page__')) return false;
        return true;
      };

      Array.from(contentEl.querySelectorAll('.__canvas_pdf_heading__')).forEach(heading => {
        try {
          if (!heading.isConnected) return;
          if (heading.closest('.__canvas_pdf_keep_with_next__')) return;

          // Climb out of a heading wrapper (e.g. a banner holding a title plus
          // a meta line) so the whole visual heading block is what moves. Only
          // climb while the parent is barely bigger than the heading itself,
          // otherwise we would swallow a real content container.
          let block = heading;
          let climbGuard = 0;
          while (block.parentElement && block.parentElement !== contentEl && climbGuard < 4) {
            const parentEl = block.parentElement;
            if (!BLOCK_TAGS.test(parentEl.tagName)) break;
            if (parentEl.classList.contains('__canvas_pdf_keep_with_next__')) break;
            const parentHeight = parentEl.offsetHeight;
            const blockHeight = block.offsetHeight;
            if (!parentHeight || !blockHeight) break;
            if (parentHeight > Math.max(140, blockHeight * 2.2)) break;
            block = parentEl;
            climbGuard++;
          }

          const next = block.nextElementSibling;
          if (!canGroup(next)) return;

          const parent = block.parentElement;
          if (!parent || next.parentElement !== parent) return;
          if (/flex|grid/.test(view.getComputedStyle(parent).display || '')) return;

          const groupHeight = (block.offsetHeight || 0) + (next.offsetHeight || 0);
          if (!groupHeight || groupHeight > MAX_GROUP_HEIGHT) return;

          const wrapper = doc.createElement('div');
          wrapper.className = '__canvas_pdf_keep_with_next__';
          parent.insertBefore(wrapper, block);
          wrapper.appendChild(block);
          wrapper.appendChild(next);
          headingGroups++;
        } catch (e) {}
      });

      if (headingGroups > 0) {
        captureNotes.push(headingGroups + ' heading group(s)');
      }
    }

    // Optional Table of Contents injection
    let tocEl = null;
    if (opts.tableOfContents && detectedHeadings.length > 0) {
      tocEl = doc.createElement('div');
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
      coverEl = doc.createElement('div');
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

    // ---------------------------------------------------------------------
    // STEP 7: PRINT READABILITY PASS
    // Canvas themes (and dark-mode extensions) colour text for a dark page.
    // The PDF always gets a white page, so light-on-light text would be
    // washed out and unreadable. Walk the copy top-down, composite the
    // background that is really behind each text run, and darken (or
    // lighten) only the text that would otherwise be illegible. Colours that
    // already contrast well are left exactly as the theme intended.
    // ---------------------------------------------------------------------
    const WHITE = { r: 255, g: 255, b: 255, a: 1 };
    const MIN_CONTRAST = 2.5;
    let readabilityFixes = 0;
    let surfaceFixes = 0;

    function parseCssColor(value) {
      if (!value) return null;
      const str = String(value).trim().toLowerCase();
      if (!str) return null;
      if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

      let match = str.match(/^rgba?\(([^)]+)\)$/);
      if (match) {
        const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
        if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
          return {
            r: parts[0], g: parts[1], b: parts[2],
            a: parts.length > 3 && !isNaN(parts[3]) ? parts[3] : 1
          };
        }
        return null;
      }

      match = str.match(/^color\(srgb\s+([^)]+)\)$/);
      if (match) {
        const parts = match[1].split(/[\s\/]+/).filter(Boolean).map(parseFloat);
        if (parts.length >= 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
          return {
            r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255,
            a: parts.length > 3 && !isNaN(parts[3]) ? parts[3] : 1
          };
        }
      }
      return null;
    }

    function srgbChannel(v) {
      const c = Math.min(255, Math.max(0, v)) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    function colorLuminance(c) {
      return 0.2126 * srgbChannel(c.r) + 0.7152 * srgbChannel(c.g) + 0.0722 * srgbChannel(c.b);
    }

    function blendColor(fg, bg) {
      const a = Math.min(1, Math.max(0, fg.a));
      return {
        r: fg.r * a + bg.r * (1 - a),
        g: fg.g * a + bg.g * (1 - a),
        b: fg.b * a + bg.b * (1 - a),
        a: 1
      };
    }

    function contrastRatio(a, b) {
      const la = colorLuminance(a);
      const lb = colorLuminance(b);
      const hi = Math.max(la, lb);
      const lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    }

    function rgbToHsl(c) {
      const r = c.r / 255;
      const g = c.g / 255;
      const b = c.b / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      let h = 0;
      let s = 0;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      return { h, s, l };
    }

    function hslToRgb(h, s, l) {
      const hue2rgb = (p, q, t) => {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
      };
      if (s === 0) {
        const v = l * 255;
        return { r: v, g: v, b: v };
      }
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      return {
        r: hue2rgb(p, q, h + 1 / 3) * 255,
        g: hue2rgb(p, q, h) * 255,
        b: hue2rgb(p, q, h - 1 / 3) * 255
      };
    }

    function readableTextColor(painted, bg) {
      const bgIsLight = colorLuminance(bg) > 0.5;
      const hsl = rgbToHsl(painted);
      const targetLightness = bgIsLight ? Math.min(hsl.l, 0.3) : Math.max(hsl.l, 0.9);
      let candidate = hslToRgb(hsl.h, Math.min(hsl.s, 0.85), targetLightness);
      if (contrastRatio(candidate, bg) < MIN_CONTRAST) {
        candidate = bgIsLight ? { r: 31, g: 41, b: 55 } : { r: 248, g: 250, b: 252 };
      }
      return 'rgb(' + Math.round(candidate.r) + ', ' + Math.round(candidate.g) + ', ' + Math.round(candidate.b) + ')';
    }

    function hasOwnText(el) {
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && node.textContent.replace(/\s+/g, '').length > 0) return true;
      }
      return false;
    }

    // What background did the live page really paint behind this content? If
    // it was dark, the copy's translucent-white "surfaces" were designed for
    // a dark backdrop and would be invisible on the printed white page.
    function resolvePageBackground(el) {
      const chain = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        chain.push(cur);
        cur = cur.parentElement;
      }
      let bg = WHITE;
      for (let i = chain.length - 1; i >= 0; i--) {
        const c = parseCssColor(window.getComputedStyle(chain[i]).backgroundColor);
        if (c && c.a > 0.02) bg = blendColor(c, bg);
      }
      return bg;
    }

    const themeIsDark = colorLuminance(resolvePageBackground(sourceEl)) < 0.35;

    (function fixContrast(el, inheritedBg, backgroundKnown) {
      const cs = view.getComputedStyle(el);
      // Print forces the ancestor shells transparent, so their screen-time
      // backgrounds must not influence the contrast measurement.
      const isWrapper = el.classList.contains('__canvas_pdf_wrap__');
      let bg = inheritedBg;
      let known = backgroundKnown;

      if (!isWrapper && cs.backgroundImage && cs.backgroundImage !== 'none') {
        known = false; // gradient / image: the painted colour is unknown
      }

      let appliedBg = isWrapper ? null : parseCssColor(cs.backgroundColor);
      if (appliedBg && appliedBg.a > 0.02) {
        // Dark themes build "surfaces" out of translucent white. On a white
        // page those vanish, so flip them to an equivalent dark tint.
        const isTranslucentWhite = appliedBg.a < 0.7 &&
                                   appliedBg.r > 200 && appliedBg.g > 200 && appliedBg.b > 200;
        if (themeIsDark && isTranslucentWhite && colorLuminance(bg) > 0.75) {
          appliedBg = { r: 15, g: 23, b: 42, a: Math.min(0.85, appliedBg.a * 0.8) };
          el.style.setProperty('background-color', 'rgba(15, 23, 42, ' + appliedBg.a.toFixed(3) + ')', 'important');
          surfaceFixes++;
        }
        bg = blendColor(appliedBg, bg);
        if (appliedBg.a > 0.98) known = true;
      }

      // Chrome paints glyphs with -webkit-text-fill-color when a theme sets it.
      const fillRaw = cs.webkitTextFillColor || cs.getPropertyValue('-webkit-text-fill-color');
      const paintSource = fillRaw && fillRaw !== 'currentcolor' ? fillRaw : cs.color;
      const fg = parseCssColor(paintSource) || parseCssColor(cs.color);
      // Gradient/"background-clip: text" headings have no real text colour.
      const clipsText = /text/.test(cs.webkitBackgroundClip || cs.backgroundClip || '');

      if (known && fg && !clipsText && hasOwnText(el)) {
        const painted = fg.a < 1 ? blendColor(fg, bg) : fg;
        if (contrastRatio(painted, bg) < MIN_CONTRAST) {
          const fixed = readableTextColor(painted, bg);
          el.style.setProperty('color', fixed, 'important');
          el.style.setProperty('-webkit-text-fill-color', fixed, 'important');
          readabilityFixes++;
        }
      }

      // A collapsed/near-invisible container is almost always an animation or
      // loading state rather than a design choice; restore it for print.
      const opacity = parseFloat(cs.opacity);
      if (opacity < 0.15 && (el.textContent || '').trim().length > 20) {
        el.style.setProperty('opacity', '1', 'important');
      }

      Array.from(el.children).forEach(child => fixContrast(child, bg, known));
    })(contentEl, WHITE, true);

    if (readabilityFixes > 0) {
      captureNotes.push(readabilityFixes + ' text colour(s) adjusted for print');
    }
    if (surfaceFixes > 0) {
      captureNotes.push(surfaceFixes + ' surface(s) re-tinted for print');
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

    styleTag = doc.createElement('style');
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

        /* This stylesheet lives in the copy's own document, so it never
           affects Canvas' page/layout while the preview is open. */
        html, body {
          background: #ffffff !important;
          margin: 0 !important;
          padding: 0 !important;
          height: auto !important;
          min-height: auto !important;
          overflow: visible !important;
        }

        /* Shallow ancestor copies only exist so Canvas descendant selectors match */
        .__canvas_pdf_wrap__ {
          position: static !important;
          margin: 0 !important;
          padding: 0 !important;
          border: 0 !important;
          width: auto !important;
          max-width: 100% !important;
          min-width: 0 !important;
          min-height: 0 !important;
          height: auto !important;
          max-height: none !important;
          overflow: visible !important;
          float: none !important;
          transform: none !important;
          /* Canvas layout chrome must not tint the printed page: the
             readability pass measured contrast against this white base. */
          background: transparent !important;
          background-image: none !important;
          opacity: 1 !important;
          filter: none !important;
        }

        .__canvas_pdf_wrap_block__ {
          display: block !important;
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

        /* Embedded frames copied inline (text entry editor, same-origin embeds) */
        .__canvas_pdf_embed_expanded__ {
          margin: 6px 0 !important;
          max-width: 100% !important;
          overflow: visible !important;
        }

        /* Placeholder for embedded tools / videos that cannot live in a PDF */
        .__canvas_pdf_embed_placeholder__ {
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          min-height: 48px !important;
          padding: 12px !important;
          border: 1px dashed #94a3b8 !important;
          border-radius: 6px !important;
          background: #f8fafc !important;
          color: #64748b !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          font-size: 9pt !important;
          text-align: center !important;
          page-break-inside: avoid !important;
          break-inside: avoid !important;
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
        .__canvas_pdf_keep_with_next__,
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
    doc.head.appendChild(styleTag);

    // Cleanup: the copy lives entirely inside `frame`; the only other change on
    // Canvas' page is the tab title, which is restored. Canvas' document, its
    // ids, its styles and its layout are never touched.
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try { if (savedDocumentTitle !== null) document.title = savedDocumentTitle; } catch (e) {}
      removeInjectedNodes();
      try { view.removeEventListener('afterprint', cleanup); } catch (e) {}
      window.removeEventListener('afterprint', cleanup);
      window.removeEventListener('pagehide', cleanup);
    };

    try { view.addEventListener('afterprint', cleanup); } catch (e) {}
    window.addEventListener('afterprint', cleanup);
    window.addEventListener('pagehide', cleanup);
    // Safety net in case the print events never fire (cancelled preview, etc.)
    setTimeout(cleanup, 15 * 60 * 1000);

    // Let the copy's layout settle before the snapshot is taken.
    try {
      if (doc.fonts && doc.fonts.ready) {
        await Promise.race([doc.fonts.ready, new Promise(resolve => setTimeout(resolve, 2000))]);
      }
    } catch (e) {}
    await new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));

    // One line, right before printing — no alarming "not found" wording.
    console.info('[Canvas→PDF] ' + describeSource(sourceSelector) + ' captured' +
      (captureNotes.length ? ': ' + captureNotes.join(', ') : '') + '.');

    // Print the copy's document, not Canvas' page: Canvas keeps its screen
    // layout (and its React containers keep their size) the whole time.
    try {
      view.print();
    } catch (printErr) {
      cleanup();
      return { error: 'The print preview could not be opened for the generated copy. Please try again.' };
    }

    return {
      success: true,
      title: cleanPdfName,
      source: sourceSelector,
      label: describeSource(sourceSelector),
      readabilityFixes: readabilityFixes,
      surfaceFixes: surfaceFixes,
      themeDark: themeIsDark,
      headingGroups: headingGroups,
      math: { found: mathImageFound, typeset: mathRendered, keptAsImages: mathImageKept }
    };
  } catch (err) {
    removeInjectedNodes();
    try { if (savedDocumentTitle !== null) document.title = savedDocumentTitle; } catch (e) {}
    return { error: err.toString() };
  }
}
