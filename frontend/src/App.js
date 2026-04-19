import React, { useState, useEffect, useCallback } from 'react';
import '@/App.css';
import api from './api';
import { ModalProvider } from './components/ModalProvider';
import HomePage from './pages/HomePage';
import SetupPage from './pages/SetupPage';
import BasicsPage from './pages/BasicsPage';
import CallsPage from './pages/CallsPage';
import SupTransferPage from './pages/SupTransferPage';
import NewbieShiftPage from './pages/NewbieShiftPage';
import ReviewPage from './pages/ReviewPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import HelpPage from './pages/HelpPage';

const LOGO_SRC = 'logo.png';

const NAV_ITEMS = [
  { key: 'home', label: 'Home', emoji: '\uD83C\uDFE0' },
  { key: 'basics', label: 'The Basics', emoji: '\uD83D\uDCCB' },
  { key: 'calls', label: 'Calls', emoji: '\uD83D\uDCDE' },
  { key: 'suptransfer', label: 'Sup Transfer', emoji: '\uD83D\uDD04' },
  { key: 'review', label: 'Review', emoji: '\uD83D\uDCC4' },
  { key: 'history', label: 'History', emoji: '\uD83D\uDCCA' },
  { key: 'settings', label: 'Settings', emoji: '\u2699\uFE0F' },
  { key: 'help', label: 'Help', emoji: '\u2753' },
];

const UNSAVED_TRACKED_PAGES = new Set(['setup', 'basics', 'calls', 'suptransfer', 'newbieshift', 'review']);

function resolveScreenshotUrl(imageUrl) {
  const value = String(imageUrl || '').trim();
  if (!value) return '';
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  return value.replace(/^\/+/, '');
}

function PageRouter({ page, navigate }) {
  const props = { onNavigate: navigate };
  switch (page) {
    case 'setup': return <SetupPage {...props} />;
    case 'home': return <HomePage {...props} />;
    case 'basics': return <BasicsPage {...props} />;
    case 'calls': return <CallsPage {...props} />;
    case 'suptransfer': return <SupTransferPage {...props} />;
    case 'newbieshift': return <NewbieShiftPage {...props} />;
    case 'review': return <ReviewPage {...props} />;
    case 'history': return <HistoryPage {...props} />;
    case 'settings': return <SettingsPage {...props} />;
    case 'help': return <HelpPage {...props} />;
    default: return <HomePage {...props} />;
  }
}

function App() {
  const [page, setPage] = useState('home');
  const [settings, setSettings] = useState(null);
  const [tickerMessages, setTickerMessages] = useState([]);
  const [discordOpen, setDiscordOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem('mts-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
    window.electronAPI?.setUnsavedChanges?.(false).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getSettings();
        if (cancelled) return;
        setSettings(s);
        if (!s.setup_complete) setPage('setup');
      } catch (_err) {
        // Backend unreachable
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const fetchTicker = async () => {
      try {
        const data = await api.getTicker();
        if (data.messages?.length > 0) setTickerMessages(data.messages);
      } catch (_err) {
        // Non-critical
      }
    };
    fetchTicker();
    const interval = setInterval(fetchTicker, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!UNSAVED_TRACKED_PAGES.has(page)) {
      return undefined;
    }

    const markUnsaved = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const isFormControl = target.matches('input, select, textarea');
      if (!isFormControl) {
        return;
      }

      if (target.hasAttribute('readonly') || target.hasAttribute('disabled')) {
        return;
      }

      window.electronAPI?.setUnsavedChanges?.(true).catch(() => {});
    };

    document.addEventListener('input', markUnsaved, true);
    document.addEventListener('change', markUnsaved, true);

    return () => {
      document.removeEventListener('input', markUnsaved, true);
      document.removeEventListener('change', markUnsaved, true);
    };
  }, [page]);

  const navigate = useCallback((p) => {
    setPage(p);
    if (page === 'settings') {
      api.getSettings().then(s => setSettings(s)).catch(() => {});
    }
  }, [page]);

  const handleExit = useCallback(() => {
    if (window.electronAPI?.quitApp) {
      window.electronAPI.quitApp().catch((err) => {
        console.error('[APP] Failed to quit desktop app:', err);
      });
      return;
    }

    window.close();
  }, []);

  const tickerContent = tickerMessages.length > 0
    ? tickerMessages.join('  \u25C6  ')
    : 'Welcome to Mock Testing Suite v3.0';

  return (
    <ModalProvider>
      <div className="app-root" data-testid="app-root">
        <div className="ticker-bar">
          <div className="ticker-track">
            <span className="ticker-content">{tickerContent}</span>
            <span className="ticker-content" aria-hidden="true">{tickerContent}</span>
          </div>
        </div>
        <div className="app-shell">
          <aside className="sidebar" data-testid="sidebar">
            <div className="sidebar-brand">
              <img src={LOGO_SRC} alt="ACD" className="sidebar-logo-img" />
              <div className="sidebar-title">Mock Testing<br />Suite</div>
              <div className="sidebar-version">v2.5.0</div>
            </div>
            <nav className="sidebar-nav">
              {NAV_ITEMS.map(item => (
                <button key={item.key} className={`nav-btn ${page === item.key ? 'active' : ''}`} onClick={() => navigate(item.key)} data-testid={`nav-${item.key}`} title={`Open ${item.label}`}>
                  <span className="nav-emoji">{item.emoji}</span>
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </nav>
            <div className="sidebar-divider" />
            <div className="sidebar-actions">
              <button className="action-btn action-discord" onClick={() => setDiscordOpen(true)} data-testid="link-discord" title="Open Discord message templates">
                <span className="action-emoji">{'\uD83D\uDCAC'}</span><span>Discord Post</span>
              </button>
            </div>
            <div className="sidebar-footer">
              <button className="exit-btn" onClick={handleExit} data-testid="exit-btn" title="Close the desktop app">{'\uD83D\uDEAA'} Exit App</button>
            </div>
          </aside>

          <main className="content-area">
            <div className="page-content" data-testid="page-content">
              {loading ? <div className="page-loading">Connecting to server...</div> : <PageRouter page={page} navigate={navigate} />}
            </div>
            <div className="status-bar">
              <span id="status-text"></span>
              <span className="status-spacer" />
              <span>Mock Testing Suite v2.5.0 — By Shawn P. Bly</span>
            </div>
          </main>
        </div>

        {discordOpen && <DiscordModal settings={settings} onClose={() => setDiscordOpen(false)} />}
      </div>
    </ModalProvider>
  );
}

function DiscordModal({ settings, onClose }) {
  const templates = settings?.discord_templates || [];
  const screenshots = settings?.discord_screenshots || [];
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('templates');
  const filteredTemplates = templates.filter(([trigger, msg]) =>
    trigger.toLowerCase().includes(search.toLowerCase()) || msg.toLowerCase().includes(search.toLowerCase())
  );
  const filteredScreenshots = screenshots.filter(s =>
    s.title.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="modal-overlay open" onClick={e => { if (e.target.classList.contains('modal-overlay')) onClose(); }} data-testid="discord-modal">
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 700, maxHeight: '85vh' }}>
        <div className="modal-header">
          <h2>Discord Post</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div style={{ padding: '0 24px 8px', display: 'flex', gap: 8 }}>
          <button className={`tab-btn ${tab === 'templates' ? 'active' : ''}`} onClick={() => setTab('templates')} style={{ padding: '6px 14px' }}>Templates</button>
          <button className={`tab-btn ${tab === 'screenshots' ? 'active' : ''}`} onClick={() => setTab('screenshots')} style={{ padding: '6px 14px' }}>Screenshots</button>
        </div>
        <div style={{ padding: '0 24px 12px' }}>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={tab === 'templates' ? 'Search templates...' : 'Search screenshots...'} data-testid="discord-search" style={{ width: '100%' }} />
        </div>
        <div className="modal-body" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
          {tab === 'templates' ? (
            filteredTemplates.length === 0 ? (
              <p className="text-muted" style={{ padding: 20 }}>No templates match your search.</p>
            ) : filteredTemplates.map(([title, message], i) => (
              <DiscordRow key={i} title={title} message={message} />
            ))
          ) : (
            filteredScreenshots.length === 0 ? (
              <p className="text-muted" style={{ padding: 20 }}>No screenshots match your search.</p>
            ) : filteredScreenshots.map((ss, i) => (
              <DiscordScreenshotRow key={i} title={ss.title} imageUrl={ss.image_url} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function DiscordRow({ title, message }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="discord-row">
      <div className="discord-title">{title}</div>
      <div className="discord-msg">{message}</div>
      <button className={`discord-copy ${copied ? 'copied' : ''}`} onClick={() => {
        navigator.clipboard.writeText(message);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}>{copied ? 'Copied!' : 'Copy'}</button>
    </div>
  );
}

function DiscordScreenshotRow({ title, imageUrl }) {
  const [copied, setCopied] = useState(false);
  const resolvedImageUrl = resolveScreenshotUrl(imageUrl);
  const handleCopy = async () => {
    try {
      const resp = await fetch(resolvedImageUrl);
      const blob = await resp.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_e) {
      // Fallback: open image in new tab
      window.open(resolvedImageUrl, '_blank');
    }
  };
  return (
    <div className="discord-row" style={{ flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="discord-title">{title}</div>
        <button className={`discord-copy ${copied ? 'copied' : ''}`} onClick={handleCopy}>{copied ? 'Copied!' : 'Copy Image'}</button>
      </div>
      <img src={resolvedImageUrl} alt={title} style={{ width: '100%', maxHeight: 300, objectFit: 'contain', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }} />
    </div>
  );
}

export default App;
