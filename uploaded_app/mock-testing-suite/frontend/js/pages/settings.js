/**
 * settings.js — Tabbed settings screen.
 * No Ticker or Update URL settings — those are hardcoded by the developer in config.py.
 */
import { api } from '../api.js';
import { modal } from '../modal.js';

const TABS = ['General', 'Gemini', 'Google Sheet', 'Calendar', 'Discord', 'Payment'];

export async function render(content, footer) {
  let settings;
  try { settings = await api.getSettings(); } catch { settings = {}; }

  const pay = settings.payment || {};
  const discord = settings.discord_templates || [];

  content.innerHTML = `
    <h1 style="margin-bottom:var(--space-lg);">Settings</h1>

    <div class="tabs-header" id="settings-tabs">
      ${TABS.map((t, i) => `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-tab="${i}">${t}</button>`).join('')}
    </div>

    <div id="settings-panels">
      <!-- General -->
      <div class="settings-panel" data-panel="0">
        <div class="card">
          <div class="form-row"><label>Tester Name</label><input type="text" id="s-name" value="${esc(settings.tester_name || '')}" style="max-width:300px;"></div>
          <div class="form-row"><label>Display Name</label><input type="text" id="s-display" value="${esc(settings.display_name || '')}" placeholder="What the Home screen calls you" style="max-width:300px;"></div>
          <div class="form-row"><label>Cert Form URL</label><input type="text" id="s-form-url" value="${esc(settings.form_url || '')}" style="max-width:500px;"></div>
          <div class="form-row"><label>Cert Sheet URL</label><input type="text" id="s-sheet-url" value="${esc(settings.cert_sheet_url || '')}" style="max-width:500px;"></div>
          <div style="margin-top:var(--space-md);">
            <label class="text-sm font-bold">Theme</label>
            <button class="btn btn-ghost btn-sm" style="margin-left:var(--space-sm);" onclick="window.__toggleTheme()">🌗 Toggle Light/Dark</button>
          </div>
        </div>
      </div>

      <!-- Gemini -->
      <div class="settings-panel" data-panel="1" style="display:none;">
        <div class="card">
          <label class="checkbox-label" style="margin-bottom:var(--space-md);"><input type="checkbox" id="s-gemini-on" ${settings.enable_gemini ? 'checked' : ''}> Enable Gemini AI Summaries</label>
          <div class="form-row"><label>API Key</label><input type="password" id="s-gemini-key" value="${esc(settings.gemini_key || '')}" placeholder="From aistudio.google.com" style="max-width:400px;"></div>
          <p class="text-muted text-sm" style="margin-top:var(--space-md);">Go to aistudio.google.com → Get API Key → Create API Key → Paste above.</p>
        </div>
      </div>

      <!-- Google Sheet -->
      <div class="settings-panel" data-panel="2" style="display:none;">
        <div class="card">
          <label class="checkbox-label" style="margin-bottom:var(--space-md);"><input type="checkbox" id="s-sheets-on" ${settings.enable_sheets ? 'checked' : ''}> Enable Google Sheets Backup</label>
          <div class="form-row"><label>Spreadsheet ID</label><input type="text" id="s-sheet-id" value="${esc(settings.sheet_id || '')}" style="max-width:400px;"></div>
          <div class="form-row"><label>Worksheet Name</label><input type="text" id="s-worksheet" value="${esc(settings.worksheet || 'Sheet1')}" style="max-width:200px;"></div>
          <div class="form-row"><label>Service Account File</label><input type="text" id="s-sa-path" value="${esc(settings.service_account_path || 'service_account.json')}" style="max-width:400px;"></div>
        </div>
      </div>

      <!-- Calendar -->
      <div class="settings-panel" data-panel="3" style="display:none;">
        <div class="card">
          <label class="checkbox-label"><input type="checkbox" id="s-cal-on" ${settings.enable_calendar ? 'checked' : ''}> Enable Google Calendar for Newbie Shifts</label>
          <p class="text-muted text-sm" style="margin-top:var(--space-md);">The calendar button generates a Google Calendar template URL. No additional setup needed.</p>
        </div>
      </div>

      <!-- Discord -->
      <div class="settings-panel" data-panel="4" style="display:none;">
        <div class="card">
          <p class="text-muted text-sm" style="margin-bottom:var(--space-md);">These templates appear in the Discord Post popup. Edit them here.</p>
          <div id="s-discord-list"></div>
          <button class="btn btn-primary btn-sm" id="s-discord-add" style="margin-top:var(--space-md);">+ Add Template</button>
        </div>
      </div>

      <!-- Payment -->
      <div class="settings-panel" data-panel="5" style="display:none;">
        <div class="card">
          <h3 style="margin-bottom:var(--space-md);">Credit Card</h3>
          <div class="form-row"><label>Type</label><input type="text" id="s-cc-type" value="${esc(pay.cc_type || 'American Express')}" style="max-width:200px;"></div>
          <div class="form-row"><label>Number</label><input type="text" id="s-cc-num" value="${esc(pay.cc_number || '3782 822463 10005')}" style="max-width:250px;"></div>
          <div class="form-row"><label>Exp</label><input type="text" id="s-cc-exp" value="${esc(pay.cc_exp || '07/2027')}" style="max-width:120px;"></div>
          <div class="form-row"><label>CVV</label><input type="text" id="s-cc-cvv" value="${esc(pay.cc_cvv || '1928')}" style="max-width:100px;"></div>
          <h3 style="margin:var(--space-lg) 0 var(--space-md);">EFT</h3>
          <div class="form-row"><label>Routing</label><input type="text" id="s-eft-rtn" value="${esc(pay.eft_routing || '021000021')}" style="max-width:200px;"></div>
          <div class="form-row"><label>Account</label><input type="text" id="s-eft-acc" value="${esc(pay.eft_account || '1357902468')}" style="max-width:200px;"></div>
        </div>
      </div>
    </div>
  `;

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.settings-panel').forEach(p => p.style.display = 'none');
      document.querySelector(`.settings-panel[data-panel="${btn.dataset.tab}"]`).style.display = 'block';
    };
  });

  // Discord templates
  const discordList = byId('s-discord-list');
  discord.forEach(([title, msg]) => addDiscordRow(discordList, title, msg));
  byId('s-discord-add').onclick = () => addDiscordRow(discordList, '', '');

  // Footer — Save button
  footer.innerHTML = `<span class="spacer"></span><button class="btn btn-primary btn-lg" id="s-save">💾 Save Settings</button>`;

  byId('s-save').onclick = async () => {
    const discordData = [];
    discordList.querySelectorAll('.discord-edit-row').forEach(row => {
      const title = row.querySelector('.de-title').value.trim();
      const msg = row.querySelector('.de-msg').value.trim();
      if (title || msg) discordData.push([title, msg]);
    });

    const payload = {
      tester_name: byId('s-name').value.trim(),
      display_name: byId('s-display').value.trim(),
      form_url: byId('s-form-url').value.trim(),
      cert_sheet_url: byId('s-sheet-url').value.trim(),
      enable_gemini: byId('s-gemini-on').checked,
      gemini_key: byId('s-gemini-key').value.trim(),
      enable_sheets: byId('s-sheets-on').checked,
      sheet_id: byId('s-sheet-id').value.trim(),
      worksheet: byId('s-worksheet').value.trim(),
      service_account_path: byId('s-sa-path').value.trim(),
      enable_calendar: byId('s-cal-on').checked,
      discord_templates: discordData,
      payment: {
        cc_type: byId('s-cc-type').value.trim(), cc_number: byId('s-cc-num').value.trim(),
        cc_exp: byId('s-cc-exp').value.trim(), cc_cvv: byId('s-cc-cvv').value.trim(),
        eft_routing: byId('s-eft-rtn').value.trim(), eft_account: byId('s-eft-acc').value.trim(),
      },
    };

    try {
      await api.saveSettings(payload);
      await modal.alert('Settings Saved', 'Your settings have been saved successfully.');
    } catch (e) { await modal.error('Save Failed', e.message); }
  };
}

function addDiscordRow(container, title, msg) {
  const row = document.createElement('div');
  row.className = 'discord-edit-row';
  row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;';
  row.innerHTML = `
    <input type="text" class="de-title" value="${esc(title)}" placeholder="Title" style="max-width:140px;">
    <textarea class="de-msg" rows="2" style="flex:1;">${esc(msg)}</textarea>
    <button class="btn btn-danger btn-sm" style="flex-shrink:0;">✕</button>
  `;
  row.querySelector('button').onclick = () => row.remove();
  container.appendChild(row);
}

function byId(id) { return document.getElementById(id); }
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
