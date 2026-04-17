/**
 * app.js — Mock Testing Suite frontend entry point.
 *
 * Handles:
 * - Sidebar navigation (hash-based SPA routing)
 * - News ticker (polls backend every 90 seconds)
 * - Discord Post popup modal
 * - External link buttons (Tracker Sheet, Cert Spreadsheet)
 * - Exit confirmation
 * - Theme toggle (persisted in localStorage + backend settings)
 * - Auto-save status indicator
 */
import { api } from './api.js';
import { router } from './router.js';
import { showTutorial } from './tutorial.js';
import { modal } from './modal.js';

// ═══════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('mts-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  // Persist to backend too
  api.saveSettings({ theme: next }).catch(() => {});
}

// Expose globally for settings page
window.__applyTheme = applyTheme;
window.__toggleTheme = toggleTheme;

// ═══════════════════════════════════════════════════════════════
// SIDEBAR NAVIGATION
// ═══════════════════════════════════════════════════════════════
function initSidebar() {
  const navBtns = document.querySelectorAll('.nav-btn[data-page]');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      router.navigate(btn.dataset.page);
    });
  });

  // Update active state on route change
  window.addEventListener('hashchange', updateSidebarActive);
}

function updateSidebarActive() {
  const current = (window.location.hash || '#home').slice(1);
  document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === current);
  });
}

// ═══════════════════════════════════════════════════════════════
// NEWS TICKER
// ═══════════════════════════════════════════════════════════════
let tickerMessages = [];
const TICKER_POLL_MS = 90_000; // 90 seconds
const TICKER_SEP = '<span class="ticker-sep">◆</span>';

async function fetchTicker() {
  try {
    const data = await api.getTicker();
    if (data.messages && data.messages.length > 0) {
      tickerMessages = data.messages;
      renderTicker();
    }
  } catch (err) {
    console.warn('[ticker] Fetch failed:', err.message);
  }
}

function renderTicker() {
  const el = document.getElementById('ticker-content');
  if (!el || tickerMessages.length === 0) return;

  // Build the ticker text — doubled so the scroll loops seamlessly
  const joined = tickerMessages.join(` ${TICKER_SEP} `);
  const doubled = `${joined} ${TICKER_SEP} ${joined} ${TICKER_SEP} `;
  el.innerHTML = doubled;

  // Adjust speed based on content length (longer = slower)
  const charCount = tickerMessages.join('').length;
  const speed = Math.max(20, Math.min(60, charCount * 0.4));
  document.querySelector('.ticker-bar').style.setProperty('--ticker-speed', `${speed}s`);
}

function startTickerPolling() {
  fetchTicker(); // Initial fetch
  setInterval(fetchTicker, TICKER_POLL_MS);
}

// ═══════════════════════════════════════════════════════════════
// DISCORD POST POPUP
// ═══════════════════════════════════════════════════════════════
let discordTemplates = [];

async function loadDiscordTemplates() {
  try {
    const settings = await api.getSettings();
    discordTemplates = settings.discord_templates || [];
  } catch {
    discordTemplates = [];
  }
}

function openDiscordModal() {
  const overlay = document.getElementById('modal-overlay');
  const list = document.getElementById('discord-list');

  list.innerHTML = '';

  if (discordTemplates.length === 0) {
    list.innerHTML = '<p class="text-muted" style="padding:20px;">No templates configured. Add them in Settings → Discord tab.</p>';
  } else {
    for (const [title, message] of discordTemplates) {
      const row = document.createElement('div');
      row.className = 'discord-row';

      const titleEl = document.createElement('div');
      titleEl.className = 'discord-title';
      titleEl.textContent = title;

      const msgEl = document.createElement('div');
      msgEl.className = 'discord-msg';
      msgEl.textContent = message;

      const copyBtn = document.createElement('button');
      copyBtn.className = 'discord-copy';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(message).then(() => {
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 1500);
        });
      });

      row.appendChild(titleEl);
      row.appendChild(msgEl);
      row.appendChild(copyBtn);
      list.appendChild(row);
    }
  }

  overlay.classList.add('open');
}

function closeDiscordModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function initDiscordModal() {
  document.getElementById('btn-discord-post').addEventListener('click', () => {
    loadDiscordTemplates().then(openDiscordModal);
  });

  document.getElementById('modal-close').addEventListener('click', closeDiscordModal);

  // Close on overlay click
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeDiscordModal();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDiscordModal();
  });
}

// ═══════════════════════════════════════════════════════════════
// EXTERNAL LINK BUTTONS
// ═══════════════════════════════════════════════════════════════
async function initExternalLinks() {
  let settings;
  try {
    settings = await api.getSettings();
  } catch {
    settings = {};
  }

  // My Tracker Sheet
  document.getElementById('btn-tracker-sheet').addEventListener('click', () => {
    const url = settings.cert_sheet_url;
    if (url) {
      window.open(url, '_blank');
    } else {
      modal.warning('No URL', 'No Tracker Sheet URL configured. Add it in Settings → General.');
    }
  });

  // Cert Spreadsheet
  document.getElementById('btn-cert-sheet').addEventListener('click', () => {
    const url = settings.cert_sheet_url;
    if (url) {
      window.open(url, '_blank');
    } else {
      modal.warning('No URL', 'No Cert Spreadsheet URL configured. Add it in Settings → General.');
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// EXIT CONFIRMATION
// ═══════════════════════════════════════════════════════════════
function initExit() {
  document.getElementById('btn-exit').addEventListener('click', async () => {
    let hasActive = false;
    try {
      const data = await api.getCurrentSession();
      hasActive = data.has_active;
    } catch { /* ignore */ }

    const msg = hasActive
      ? 'You have an active session in progress. If you close now, unsaved data will be lost.<br><br>Exit anyway?'
      : 'Are you sure you want to exit Mock Testing Suite?';

    const yes = await modal.confirm('Exit App', msg, '🚪');
    if (yes) {
      // Try pywebview's destroy, then fallback
      try { window.pywebview && window.pywebview.api && window.pywebview.api.close(); } catch {}
      try { window.close(); } catch {}
      // If neither works, just navigate away
      document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:var(--text-tertiary);">You can close this window now.</div>';
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// AUTO-SAVE STATUS
// ═══════════════════════════════════════════════════════════════
function startStatusPolling() {
  setInterval(async () => {
    try {
      const data = await api.getCurrentSession();
      const el = document.getElementById('status-text');
      if (data.session && data.session.last_saved) {
        el.textContent = `Draft saved at ${data.session.last_saved}`;
      } else {
        el.textContent = '';
      }
    } catch { /* ignore */ }
  }, 65_000); // Slightly offset from 60s auto-save to catch updates
}

// ═══════════════════════════════════════════════════════════════
// PAGE REGISTRATION
// ═══════════════════════════════════════════════════════════════
const PAGES = ['home', 'basics', 'calls', 'suptransfer', 'newbieshift', 'review', 'history', 'settings', 'help', 'setup'];

function registerPages() {
  for (const page of PAGES) {
    router.register(page, async (content, footer) => {
      try {
        const mod = await import(`./pages/${page}.js`);
        await mod.render(content, footer);
      } catch (err) {
        content.innerHTML = `
          <div class="card" style="margin-top:30px;padding:30px;">
            <h2>Error Loading Page</h2>
            <p class="text-muted mt-sm">${err.message}</p>
          </div>`;
        footer.innerHTML = '';
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
async function init() {
  // Apply saved theme
  const savedTheme = localStorage.getItem('mts-theme') || 'dark';
  applyTheme(savedTheme);

  // Wire up sidebar, modal, links, exit
  initSidebar();
  initDiscordModal();
  initExit();

  // Check backend connectivity + setup status
  try {
    const settings = await api.getSettings();

    // Sync theme from backend if first visit
    if (!localStorage.getItem('mts-theme') && settings.theme) {
      applyTheme(settings.theme);
    }

    // Load external links
    initExternalLinks();

    // If setup not complete, redirect to wizard
    if (!settings.setup_complete) {
      window.location.hash = '#setup';
    }

    // Show tutorial on first launch after setup
    if (settings.setup_complete && !settings.tutorial_completed) {
      setTimeout(() => showTutorial(), 600);
    }
  } catch (err) {
    console.error('[init] Backend unreachable:', err);
    document.getElementById('page-content').innerHTML = `
      <div class="card" style="margin:60px auto;max-width:520px;text-align:center;padding:40px;">
        <h2 style="margin-bottom:12px;">Cannot Connect to Server</h2>
        <p class="text-muted">Make sure the Python backend is running:</p>
        <pre class="font-mono mt-md" style="color:var(--color-primary);font-size:13px;background:var(--bg-input);padding:12px;border-radius:6px;">cd backend && python server.py</pre>
      </div>`;
    return;
  }

  // Register pages and start router
  registerPages();
  router.start();
  updateSidebarActive();

  // Start background services
  startTickerPolling();
  startStatusPolling();

  // Check for updates
  checkForUpdate();
}

async function checkForUpdate() {
  try {
    const result = await api.checkForUpdate();
    if (result.update_available) {
      const banner = document.createElement('div');
      banner.id = 'update-banner';
      banner.style.cssText = `
        position:fixed;top:30px;left:var(--sidebar-width);right:0;z-index:500;
        background:linear-gradient(90deg,#1e40af,#2563eb);color:white;
        padding:10px 24px;display:flex;align-items:center;gap:12px;
        font-size:13px;font-weight:600;font-family:var(--font-body);
        box-shadow:0 4px 12px rgba(0,0,0,0.3);
      `;
      banner.innerHTML = `
        <span>🚀 Update available: v${result.latest_version}${result.release_notes ? ' — ' + result.release_notes : ''}</span>
        <span style="flex:1;"></span>
        ${result.download_url ? `<a href="${result.download_url}" target="_blank" style="color:white;background:#16a34a;padding:5px 14px;border-radius:4px;text-decoration:none;font-weight:700;">Download</a>` : ''}
        <button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,0.7);font-size:18px;cursor:pointer;padding:0 4px;">✕</button>
      `;
      document.body.appendChild(banner);
    }
  } catch { /* silent — update check is non-critical */ }
}

document.addEventListener('DOMContentLoaded', init);
