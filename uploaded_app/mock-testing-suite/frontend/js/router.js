/**
 * router.js — Minimal hash-based SPA router.
 *
 * Usage:
 *   import { router } from './router.js';
 *   router.register('home', renderHomePage);
 *   router.register('basics', renderBasicsPage);
 *   router.start();             // listens to hashchange
 *   router.navigate('calls');   // programmatic nav
 */

const routes = {};
let currentPage = null;
let beforeNavigateHook = null;

function getHash() {
  return (window.location.hash || '#home').slice(1);
}

async function resolve() {
  const page = getHash();
  if (page === currentPage) return;

  // Before-navigate hook (e.g. "are you sure you want to leave?")
  if (beforeNavigateHook && currentPage) {
    const proceed = await beforeNavigateHook(currentPage, page);
    if (proceed === false) {
      // Revert hash without triggering another resolve
      window.history.replaceState(null, '', `#${currentPage}`);
      return;
    }
  }

  const handler = routes[page];
  if (!handler) {
    console.warn(`[router] No handler for "${page}", falling back to home`);
    window.location.hash = '#home';
    return;
  }

  currentPage = page;

  // Update sidebar active state
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  // Render page into content area
  const container = document.getElementById('page-content');
  const footer = document.getElementById('page-footer');

  container.scrollTop = 0;

  try {
    await handler(container, footer);
  } catch (err) {
    console.error(`[router] Error rendering "${page}":`, err);
    container.innerHTML = `<div class="card" style="margin-top:40px;padding:30px;">
      <h2>Something went wrong</h2>
      <p class="text-muted mt-sm">${err.message}</p>
    </div>`;
  }
}

export const router = {
  /**
   * Register a page handler.
   * handler(contentEl, footerEl) — receives the content div and footer div.
   */
  register(page, handler) {
    routes[page] = handler;
  },

  /** Start listening for hash changes. */
  start() {
    window.addEventListener('hashchange', resolve);
    resolve();
  },

  /** Programmatic navigation. */
  navigate(page) {
    window.location.hash = `#${page}`;
  },

  /** Get current page key. */
  current() {
    return currentPage;
  },

  /** Set a before-navigate guard. Return false to cancel navigation. */
  setBeforeNavigate(fn) {
    beforeNavigateHook = fn;
  },
};
