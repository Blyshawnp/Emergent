/**
 * home.js — Home dashboard with stats, recent sessions, and action buttons.
 */
import { api } from '../api.js';
import { modal } from '../modal.js';

export async function render(content, footer) {
  let settings = {}, stats = {}, history = [];

  try {
    [settings, stats, history] = await Promise.all([
      api.getSettings(),
      api.getHistoryStats(),
      api.getHistory(),
    ]);
  } catch (err) {
    content.innerHTML = `<p class="text-muted">Failed to load: ${err.message}</p>`;
    footer.innerHTML = '';
    return;
  }

  const name = settings.display_name || settings.tester_name || 'Tester';
  const recent = (history || []).slice(0, 5);

  // Build recent sessions rows
  let recentHTML = '';
  if (recent.length === 0) {
    recentHTML = '<div style="padding:20px;text-align:center;color:var(--text-tertiary);">No sessions yet. Start testing to see your history here.</div>';
  } else {
    recentHTML = recent.map(s => {
      const status = s.status || '?';
      const badgeClass = {
        Pass: 'badge-pass', Fail: 'badge-fail',
        Incomplete: 'badge-incomplete', 'NC/NS': 'badge-ncns',
      }[status] || 'badge-ncns';

      return `
        <div class="recent-row">
          <span class="recent-date">${s.timestamp || 'Unknown'}</span>
          <span class="recent-name">${s.candidate || 'Unknown'}</span>
          <span class="badge ${badgeClass}">${status}</span>
        </div>`;
    }).join('');
  }

  content.innerHTML = `
    <div class="home-header">
      <h1>Welcome, ${escapeHTML(name)}!</h1>
      <p class="text-muted">Mock Testing Suite — Certification</p>
    </div>

    <div class="stats-row">
      ${statCard('Total Sessions', stats.total || 0, '')}
      ${statCard('Passed', stats.passes || 0, 'var(--color-success)')}
      ${statCard('Failed', stats.fails || 0, 'var(--color-danger)')}
      ${statCard('NC/NS', stats.ncns || 0, 'var(--text-tertiary)')}
      ${statCard('Pass Rate', (stats.pass_rate || 0) + '%', 'var(--color-success)')}
    </div>

    <div class="home-section">
      <h3>Recent Sessions</h3>
      <div class="card" style="padding:0;overflow:hidden;">
        ${recentHTML}
      </div>
    </div>

    <div class="home-actions">
      <button class="btn btn-primary btn-lg" id="home-start"
              data-tooltip="Begin a new mock testing session from scratch">
        🚀 Start New Session
      </button>
      <button class="btn btn-success btn-lg" id="home-sup-only"
              data-tooltip="Resume a candidate for Supervisor Transfers only">
        🔄 Supervisor Transfer Only
      </button>
      <button class="btn btn-muted" onclick="location.hash='#history'"
              data-tooltip="View all past session records and stats">
        📊 Full History
      </button>
    </div>
  `;

  footer.innerHTML = '';

  // Wire up buttons
  document.getElementById('home-start').addEventListener('click', () => {
    location.hash = '#basics';
  });

  document.getElementById('home-sup-only').addEventListener('click', () => {
    // Smart Resume flow — simplified for now
    const didConduct = await modal.confirm('Smart Resume', 'Did you conduct this candidate's initial mock session?'); if (didConduct) {
      location.hash = '#basics';
    } else {
      location.hash = '#basics';
    }
  });
}

function statCard(label, value, color) {
  const colorStyle = color ? `color:${color};` : '';
  return `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value" style="${colorStyle}">${value}</div>
    </div>`;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
