// Popup script: handles user trigger and coordinates page extraction
document.addEventListener('DOMContentLoaded', async () => {
  const statusDot = document.getElementById('status-dot');
  const pageTitlePreview = document.getElementById('page-title-preview');
  const btnConvert = document.getElementById('btn-convert');
  const btnText = document.getElementById('btn-text');
  const statusMsg = document.getElementById('status-msg');
  const themeWarning = document.getElementById('theme-warning');

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
    statusDot.className = 'status-dot active';
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
    statusDot.className = 'status-dot warn';
    pageTitlePreview.textContent = activeTab.title || 'Active Tab';
  }

  btnConvert.addEventListener('click', async () => {
    btnConvert.disabled = true;
    btnText.textContent = 'Preloading & Rendering...';
    hideStatus();

    try {
      // Execute converter directly in active tab context
      // Default: NO injected redundant title banner (preserves page natural header), YES to exact colors & styles
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: executeInPlaceCanvasPrint,
        args: [{
          includeTitle: false,
          preserveColors: true
        }]
      });

      const response = results && results[0] ? results[0].result : null;
      if (response && response.error) {
        showStatus(response.error, 'error');
      } else {
        showStatus('Print dialog opened. Select "Save as PDF".', 'info');
      }
    } catch (err) {
      console.error(err);
      showStatus('Error: ' + (err.message || 'Could not process page.'), 'error');
    } finally {
      btnConvert.disabled = false;
      btnText.textContent = 'Download PDF';
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

    // Determine document title for PDF name
    let pageTitle = '';
    const titleCandidates = [
      document.querySelector('.page-title'),
      document.querySelector('h1.title'),
      document.querySelector('h1'),
      document.querySelector('#breadcrumbs li:last-child')
    ];
    for (const cand of titleCandidates) {
      if (cand && cand.textContent.trim()) {
        pageTitle = cand.textContent.trim();
        break;
      }
    }
    if (!pageTitle) {
      pageTitle = document.title.replace(/\s*:\s*.*$/, '').trim() || 'Canvas Document';
    }

    // Set document title temporarily so Chrome names the PDF file cleanly
    const originalDocumentTitle = document.title;
    document.title = pageTitle;

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

    // If title option is selected, inject temporary title banner if not already inside contentEl
    let injectedTitleEl = null;
    if (options.includeTitle) {
      const existingHeading = contentEl.querySelector('h1, h2');
      const hasHeadingTitle = existingHeading && existingHeading.textContent.trim().toLowerCase().includes(pageTitle.toLowerCase().slice(0, 15));
      if (!hasHeadingTitle) {
        injectedTitleEl = document.createElement('h1');
        injectedTitleEl.className = '__canvas_pdf_injected_title__';
        injectedTitleEl.textContent = pageTitle;
        contentEl.insertBefore(injectedTitleEl, contentEl.firstChild);
      }
    }

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

        /* Injected title banner */
        .__canvas_pdf_injected_title__ {
          visibility: visible !important;
          display: block !important;
          font-size: 24px !important;
          font-weight: 700 !important;
          color: #111827 !important;
          margin: 0 0 20px 0 !important;
          padding: 0 0 10px 0 !important;
          border-bottom: 2px solid #e5e7eb !important;
          line-height: 1.25 !important;
          page-break-after: avoid !important;
          break-after: avoid !important;
        }

        /* Page break intelligence: never split diagrams, images, cards, or tables */
        h1, h2, h3, h4, h5, h6 {
          page-break-after: avoid !important;
          break-after: avoid !important;
        }

        img, svg, figure, table, tr, td, th, pre, blockquote, .card, [style*="border"], [style*="background"] {
          page-break-inside: avoid !important;
          break-inside: avoid !important;
        }

        img {
          max-width: 100% !important;
          height: auto !important;
        }

        table {
          width: 100% !important;
          border-collapse: collapse !important;
        }
      }
    `;
    document.head.appendChild(styleTag);

    // Cleanup handler called after print dialog finishes (either saved or canceled)
    const cleanup = () => {
      document.title = originalDocumentTitle;
      contentEl.classList.remove(PRINT_TARGET_CLASS);
      targetAncestors.forEach(a => a.classList.remove('__canvas_pdf_ancestor__'));
      closedDetails.forEach(d => d.removeAttribute('open'));
      if (injectedTitleEl) injectedTitleEl.remove();
      if (styleTag) styleTag.remove();
      window.removeEventListener('afterprint', cleanup);
    };

    window.addEventListener('afterprint', cleanup, { once: true });

    // Trigger print dialog
    window.print();

    // Fallback cleanup in case afterprint doesn't fire in some browser edge-cases
    setTimeout(cleanup, 20000);

    return { success: true, title: pageTitle };
  } catch (err) {
    return { error: err.toString() };
  }
}
