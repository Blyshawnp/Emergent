/**
 * setup.js — First-time Setup Wizard.
 */
import { api } from '../api.js';
import { modal } from '../modal.js';

let step = 0;

export async function render(content, footer) {
  step = 0;
  buildStep(content, footer);
}

function buildStep(content, footer) {
  const steps = [
    // Step 0: Welcome
    () => {
      content.innerHTML = `
        <div style="max-width:550px;margin:60px auto;text-align:center;">
          <h1 style="font-size:var(--font-size-3xl);margin-bottom:var(--space-sm);">Welcome to Mock Testing Suite</h1>
          <p class="text-muted" style="font-size:var(--font-size-lg);margin-bottom:var(--space-xl);">Let's get your profile set up.</p>
          <div class="card" style="text-align:left;">
            <div class="form-row"><label>First Name</label><input type="text" id="w-first" placeholder="e.g. Shawn" style="max-width:250px;"></div>
            <div class="form-row"><label>Last Name</label><input type="text" id="w-last" placeholder="e.g. Bly" style="max-width:250px;"></div>
            <div class="form-row"><label>Display Name</label><input type="text" id="w-display" placeholder="What the Home screen calls you (optional)" style="max-width:300px;"></div>
          </div>
        </div>`;
      footer.innerHTML = `<span class="spacer"></span><button class="btn btn-primary" id="w-next">Next →</button>`;
      byId('w-next').onclick = () => {
        const first = byId('w-first').value.trim();
        const last = byId('w-last').value.trim();
        if (!first || !last) { await modal.warning('Missing Info', 'First and Last name are required.'); return; }
        window._wizardData = { first, last, display: byId('w-display').value.trim() || first };
        step = 1; buildStep(content, footer);
      };
    },

    // Step 1: URLs
    () => {
      content.innerHTML = `
        <div style="max-width:600px;margin:60px auto;text-align:center;">
          <h1>System Links</h1>
          <p class="text-muted" style="margin-bottom:var(--space-xl);">Pre-filled for you. Change only if they've been updated.</p>
          <div class="card" style="text-align:left;">
            <div class="form-row"><label>Cert Form URL</label><input type="text" id="w-form" value="https://forms.office.com/pages/responsepage.aspx?id=3KFHNUeYz0mR2noZwaJeQnNAxP4sz6FBkEyNHMuYWT1URDZKWk1RWDU2VjRLTEZKNUxCWU1RRFlUVS4u&route=shorturlask" style="max-width:500px;"></div>
            <div class="form-row"><label>Cert Sheet URL</label><input type="text" id="w-sheet" placeholder="Optional" style="max-width:500px;"></div>
          </div>
        </div>`;
      footer.innerHTML = `<button class="btn btn-muted" id="w-back">← Back</button><span class="spacer"></span><button class="btn btn-primary" id="w-next">Next →</button>`;
      byId('w-back').onclick = () => { step = 0; buildStep(content, footer); };
      byId('w-next').onclick = () => {
        window._wizardData.form_url = byId('w-form').value.trim();
        window._wizardData.cert_sheet_url = byId('w-sheet').value.trim();
        step = 2; buildStep(content, footer);
      };
    },

    // Step 2: Power-ups info
    () => {
      content.innerHTML = `
        <div style="max-width:550px;margin:60px auto;text-align:center;">
          <h1>Unlock App Power-Ups 🚀</h1>
          <p class="text-muted" style="margin-bottom:var(--space-xl);">You can enable these anytime in the Settings tab.</p>
          <div class="card" style="text-align:left;line-height:1.8;">
            <p>🤖 <b>Gemini AI</b> — Generates clean, professional coaching summaries from your checkboxes.</p>
            <p>📊 <b>Google Sheets</b> — Automatically backs up every session to a team spreadsheet.</p>
            <p>📅 <b>Google Calendar</b> — Adds Newbie Shifts to your calendar with one click.</p>
            <p class="text-muted text-sm" style="margin-top:var(--space-md);">Step-by-step setup guides are in the Help tab.</p>
          </div>
        </div>`;
      footer.innerHTML = `<button class="btn btn-muted" id="w-back">← Back</button><span class="spacer"></span><button class="btn btn-success btn-lg" id="w-finish">Launch App 🎉</button>`;
      byId('w-back').onclick = () => { step = 1; buildStep(content, footer); };
      byId('w-finish').onclick = async () => {
        const d = window._wizardData;
        try {
          await api.completeSetup({
            tester_name: `${d.first} ${d.last}`,
            display_name: d.display,
            form_url: d.form_url || '',
            cert_sheet_url: d.cert_sheet_url || '',
          });
          location.hash = '#home';
          location.reload();
        } catch (e) { await modal.error('Error', e.message); }
      };
    },
  ];

  steps[step]();
}

function byId(id) { return document.getElementById(id); }
