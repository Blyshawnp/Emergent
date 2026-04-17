/**
 * history.js — Session History with stats, search, view detail modal, and clear.
 */
import { api } from '../api.js';

export async function render(content, footer) {
  let stats = {}, history = [];

  try {
    [stats, history] = await Promise.all([
      api.getHistoryStats(),
      api.getHistory(),
    ]);
  } catch (e) {
    content.innerHTML = `<p class="text-muted">Failed to load history: ${e.message}</p>`;
    footer.innerHTML = '';
    return;
  }

  content.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-lg);">
      <h1>Session History</h1>
      <button class="btn btn-danger btn-sm" id="btn-clear-history" data-tooltip="Permanently delete all session records">🗑 Clear All History</button>
    </div>

    <div class="stats-row" style="margin-bottom:var(--space-lg);">
      ${statCard('Total', stats.total)}
      ${statCard('Passed', stats.passes, 'var(--color-success)')}
      ${statCard('Failed', stats.fails, 'var(--color-danger)')}
      ${statCard('NC/NS', stats.ncns, 'var(--text-tertiary)')}
      ${statCard('Incomplete', stats.incomplete, 'var(--color-warning)')}
      ${statCard('Pass Rate', stats.pass_rate + '%', 'var(--color-success)')}
    </div>

    <input type="text" id="history-search" placeholder="🔍  Search by candidate name..."
           style="margin-bottom:var(--space-md);max-width:400px;">

    <div class="card" style="padding:0;overflow:hidden;" id="history-table-card">
      ${buildTable(history)}
    </div>

    <!-- Detail Modal -->
    <div class="modal-overlay" id="history-modal-overlay">
      <div class="modal" style="width:700px;max-height:85vh;">
        <div class="modal-header">
          <h2 id="hist-modal-title">Session Details</h2>
          <button class="modal-close" id="hist-modal-close">&times;</button>
        </div>
        <div class="modal-body" id="hist-modal-body" style="line-height:1.7;"></div>
      </div>
    </div>
  `;

  footer.innerHTML = '';

  // Search filter
  document.getElementById('history-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.hist-row').forEach(row => {
      const name = (row.dataset.name || '').toLowerCase();
      row.style.display = name.includes(q) ? '' : 'none';
    });
  });

  // Clear history
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    if (history.length === 0) { await modal.warning('Notice', 'No history to clear.'); return; }
    const doClear = await modal.confirmDanger('Clear History', `This will permanently delete ${history.length} session records. This cannot be undone.`); if (!doClear) return;
    if (!await modal.confirm('Confirm', 'This cannot be undone. Are you absolutely sure?')) return;
    try {
      await api.clearHistory();
      await modal.alert('Cleared', 'Session history has been cleared.');
      render(content, footer);
    } catch (e) { await modal.error('Error', e.message); }
  });

  // View buttons
  document.querySelectorAll('.btn-view-session').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      if (idx >= 0 && idx < history.length) openDetailModal(history[idx]);
    });
  });

  // Modal close
  document.getElementById('hist-modal-close').addEventListener('click', closeModal);
  document.getElementById('history-modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'history-modal-overlay') closeModal();
  });
}


function buildTable(history) {
  if (!history || history.length === 0) {
    return '<div style="padding:30px;text-align:center;color:var(--text-tertiary);">No session history yet. Complete a session to see it here.</div>';
  }

  let html = `
    <table class="hist-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Candidate</th>
          <th>Tester</th>
          <th>Status</th>
          <th style="width:70px;"></th>
        </tr>
      </thead>
      <tbody>
  `;

  history.forEach((s, i) => {
    const status = s.status || '?';
    const badgeClass = { Pass: 'badge-pass', Fail: 'badge-fail', Incomplete: 'badge-incomplete', 'NC/NS': 'badge-ncns' }[status] || 'badge-ncns';

    html += `
      <tr class="hist-row" data-name="${esc(s.candidate || '')}">
        <td class="hist-date">${esc(s.timestamp || 'Unknown')}</td>
        <td class="hist-name">${esc(s.candidate || 'Unknown')}</td>
        <td class="hist-tester">${esc(s.tester_name || '')}</td>
        <td><span class="badge ${badgeClass}">${status}</span></td>
        <td><button class="btn btn-primary btn-sm btn-view-session" data-index="${i}">View</button></td>
      </tr>`;
  });

  html += '</tbody></table>';
  return html;
}


function openDetailModal(s) {
  const overlay = document.getElementById('history-modal-overlay');
  const title = document.getElementById('hist-modal-title');
  const body = document.getElementById('hist-modal-body');

  const status = s.status || 'Unknown';
  const statusColors = { Pass: 'var(--color-success)', Fail: 'var(--color-danger)', Incomplete: 'var(--color-warning)', 'NC/NS': 'var(--text-tertiary)' };
  const sc = statusColors[status] || 'var(--text-secondary)';

  title.innerHTML = `${esc(s.candidate || 'Unknown')} — <span style="color:${sc};">${status.toUpperCase()}</span>`;

  let html = '';
  html += `<div class="text-muted text-sm" style="margin-bottom:var(--space-md);">${esc(s.timestamp || '')}</div>`;
  html += `<strong>Tester:</strong> ${esc(s.tester_name || 'N/A')}<br>`;

  if (s.auto_fail_reason) {
    html += `<strong>Auto-Fail:</strong> <span style="color:var(--color-danger);">${esc(s.auto_fail_reason)}</span><br>`;
  }

  if (s.headset_brand) {
    html += `<strong>Headset:</strong> ${esc(s.headset_brand)}<br>`;
  }

  // Calls
  for (let i = 1; i <= 3; i++) {
    const call = s[`call_${i}`];
    if (call && call.result) {
      html += `<br><strong>Call ${i}:</strong> ${colorResult(call.result)}<br>`;
      html += `<span class="text-sm text-muted">&nbsp;&nbsp;Type: ${esc(call.type || 'N/A')}</span><br>`;
      html += `<span class="text-sm text-muted">&nbsp;&nbsp;Show: ${esc(call.show || 'N/A')}</span><br>`;
      html += `<span class="text-sm text-muted">&nbsp;&nbsp;Caller: ${esc(call.caller || 'N/A')}</span><br>`;

      const coaching = extractChecked(call.coaching);
      if (coaching.length) html += `<span class="text-sm">&nbsp;&nbsp;Coaching: ${esc(coaching.join(', '))}</span><br>`;

      if (call.result === 'Fail') {
        const fails = extractChecked(call.fails);
        if (fails.length) html += `<span class="text-sm" style="color:var(--color-danger);">&nbsp;&nbsp;Fails: ${esc(fails.join(', '))}</span><br>`;
      }
    }
  }

  // Sup transfers
  for (let i = 1; i <= 2; i++) {
    const sup = s[`sup_transfer_${i}`];
    if (sup && sup.result) {
      html += `<br><strong>Sup Transfer ${i}:</strong> ${colorResult(sup.result)}<br>`;
      html += `<span class="text-sm text-muted">&nbsp;&nbsp;Reason: ${esc(sup.reason || 'N/A')}</span><br>`;

      const coaching = extractChecked(sup.coaching);
      if (coaching.length) html += `<span class="text-sm">&nbsp;&nbsp;Coaching: ${esc(coaching.join(', '))}</span><br>`;

      if (sup.result === 'Fail') {
        const fails = extractChecked(sup.fails);
        if (fails.length) html += `<span class="text-sm" style="color:var(--color-danger);">&nbsp;&nbsp;Fails: ${esc(fails.join(', '))}</span><br>`;
      }
    }
  }

  // Newbie
  const newbie = s.newbie_shift_data;
  if (newbie) {
    html += `<br><strong>Newbie Shift:</strong> ${esc(newbie.newbie_date || '')} at ${esc(newbie.newbie_time || '')} ${esc(newbie.newbie_tz || '')}<br>`;
  }

  body.innerHTML = html;
  overlay.classList.add('open');
}


function closeModal() {
  document.getElementById('history-modal-overlay').classList.remove('open');
}


// Helpers
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function colorResult(r) {
  if (r === 'Pass') return '<span style="color:var(--color-success);font-weight:700;">PASS</span>';
  if (r === 'Fail') return '<span style="color:var(--color-danger);font-weight:700;">FAIL</span>';
  return '<span style="color:var(--text-tertiary);">—</span>';
}

function extractChecked(obj) {
  if (!obj) return [];
  return Object.entries(obj).filter(([k, v]) => v && k !== 'Other').map(([k]) => k);
}

function statCard(label, value, color) {
  const c = color ? `color:${color};` : '';
  return `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value" style="${c}">${value}</div></div>`;
}
