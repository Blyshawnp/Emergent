/**
 * suptransfer.js — Supervisor Transfer screen.
 * Grades up to 2 transfers. Pass on first → done. Fail both → newbie shift.
 */
import { api } from '../api.js';
import { modal } from '../modal.js';

let transferNum = 1;
let currentResult = null;
let defaults = {}, settings = {};

const SUP_COACHING = [
  { label: 'Minimize dead air', helper: 'Maintain engagement throughout hold and transfer' },
  { label: 'Queue Not Changed', helper: 'Did not change queue to ACD Direct Supervisor' },
  { label: 'Caller Placed On Hold' },
  { label: 'Verification', children: ['Name', 'Address', 'Phone', 'Email', 'Card/EFT', 'Phonetics for Sound Alike Letters'] },
  { label: 'Discord permission', helper: 'Ask explicit permission to transfer via Discord' },
  { label: 'Did not notify caller of transfer', helper: 'Notify caller before transferring' },
  { label: 'Screenshots/Discord Chat', helper: 'Coached with standard instructions and screenshots' },
  { label: 'Other' },
];

const SUP_FAILS = [
  'Did not ask permission to transfer', 'Did not minimize dead air', 'Caller Placed On Hold',
  'Transferred to wrong queue', 'Did not inform caller of transfer', 'Other',
];

const SUP_REASONS = [
  'Hung up on', 'Charged for a cancelled sustaining', 'Double Charged',
  'Damaged Gift', "Didn't Receive Gift", 'Cancel Sustaining', 'Use Own/Other',
];

export async function render(content, footer) {
  try { [defaults, settings] = await Promise.all([api.getDefaults(), api.getSettings()]); } catch {}
  transferNum = 1;
  currentResult = null;
  buildScreen(content, footer);
}

function buildScreen(content, footer) {
  const shows = settings.shows || defaults.shows || [];
  const callers = settings.donors_existing || defaults.donors_existing || [];
  window._supCallers = callers;

  content.innerHTML = `
    <h1 style="margin-bottom:var(--space-sm);">Supervisor Transfer #${transferNum}</h1>
    <div class="card" style="text-align:center;margin-bottom:var(--space-md);padding:var(--space-md);background:var(--color-primary);border:none;">
      <div style="color:white;font-weight:700;font-size:var(--font-size-lg);">Call Corp WXYZ Test Transfer #: 1-828-630-7006</div>
    </div>
    <div class="card" style="margin-bottom:var(--space-md);display:flex;align-items:center;justify-content:space-between;padding:var(--space-md) var(--space-lg);">
      <span><b>Discord Post for Stars:</b> WXYZ Supervisor Test Call Being Queued</span>
      <button class="btn btn-primary btn-sm" id="st-copy-discord">📋 Copy</button>
    </div>

    <div class="split-layout">
      <div class="card">
        <h3 style="margin-bottom:var(--space-md);">Call Setup</h3>
        <div class="form-row"><label>Caller</label><select id="st-caller" style="max-width:250px;">${callers.map(c => `<option>${c[0]} ${c[1]}</option>`).join('')}</select></div>
        <div class="form-row"><label>Show</label><select id="st-show" style="max-width:300px;">${shows.map(s => `<option>${s[0]}</option>`).join('')}</select></div>
        <div class="form-row"><label>Reason</label><select id="st-reason" style="max-width:300px;">${SUP_REASONS.map(r => `<option>${r}</option>`).join('')}</select></div>
      </div>
      <div class="card card-scenario">
        <h3 style="color:var(--border-scenario);margin-bottom:var(--space-sm);">SCENARIO</h3>
        <div id="st-scenario" style="line-height:1.7;">Select caller, show, and reason.</div>
      </div>
    </div>

    <div class="card" style="margin:var(--space-md) 0;">
      <h3 style="margin-bottom:var(--space-sm);">Caller Demographics</h3>
      <div id="st-demo" style="text-align:center;">Select a caller.</div>
    </div>

    <div class="card" style="margin-bottom:var(--space-md);">
      <h3>Transfer Result</h3>
      <div class="result-btns"><button class="result-btn" id="st-pass">☑ PASS</button><button class="result-btn" id="st-fail">✖ FAIL</button></div>
    </div>

    <div class="card" style="margin-bottom:var(--space-md);">
      <h3>Coaching Given</h3>
      <p class="text-muted text-sm" style="margin-bottom:var(--space-md);">One or more may be selected</p>
      <div class="coaching-grid" id="st-coaching-grid"></div>
      <div style="margin-top:var(--space-md);"><label class="text-sm font-bold">Other Coaching Notes</label><textarea id="st-coach-notes" rows="2" disabled style="margin-top:4px;"></textarea></div>
    </div>

    <div class="card card-fail" id="st-fail-card" style="display:none;margin-bottom:var(--space-md);">
      <h3 style="color:var(--color-danger);">⚠ Fail Reasons</h3>
      <div class="coaching-grid" id="st-fail-grid"></div>
      <div style="margin-top:var(--space-md);"><label class="text-sm font-bold">Other Fail Notes</label><textarea id="st-fail-notes" rows="2" disabled style="margin-top:4px;"></textarea></div>
    </div>
  `;

  // Build checkbox grids (reuse calls.js pattern inline)
  buildGrid('st-coaching-grid', SUP_COACHING, 'st-coach-notes');
  buildFailList('st-fail-grid', SUP_FAILS, 'st-fail-notes');

  // Wire events
  const update = () => updateScenario();
  byId('st-caller').onchange = update;
  byId('st-show').onchange = update;
  byId('st-reason').onchange = update;
  update();

  byId('st-copy-discord').onclick = () => {
    navigator.clipboard.writeText('WXYZ Supervisor Test Call Being Queued');
    byId('st-copy-discord').textContent = '✅ Copied!';
    setTimeout(() => byId('st-copy-discord').textContent = '📋 Copy', 1500);
  };

  byId('st-pass').onclick = () => setResult('Pass');
  byId('st-fail').onclick = () => setResult('Fail');

  footer.innerHTML = `
    <button class="btn btn-muted btn-sm" id="st-back">← Back</button>
    <button class="btn btn-danger btn-sm" id="st-stopped">⚠ Stopped Responding</button>
    <button class="btn btn-muted btn-sm" id="st-tech">🛠 Tech</button>
    <span class="spacer"></span>
    <button class="btn btn-primary" id="st-continue">Continue →</button>
  `;

  byId('st-back').onclick = () => {
    if (transferNum > 1) { transferNum--; currentResult = null; buildScreen(content, footer); }
    else location.hash = '#calls';
  };
  byId('st-stopped').onclick = async () => {
    await api.updateSession({ auto_fail_reason: 'Stopped Responding in Chat', final_status: 'Fail' });
    location.hash = '#review';
  };
  byId('st-tech').onclick = () => await modal.alert('Tech Issue', 'Tech Issue has been logged.');
  byId('st-continue').onclick = () => validateAndContinue(content, footer);
}

function updateScenario() {
  const caller = byId('st-caller').value;
  const reason = byId('st-reason').value;
  const fname = caller.split(' ')[0];
  const callers = window._supCallers || [];
  const idx = byId('st-caller').selectedIndex;

  if (idx >= 0 && idx < callers.length) {
    const c = callers[idx];
    byId('st-demo').innerHTML = `<b>${c[0]} ${c[1]}</b><br>${c[2]}, ${c[3]}, ${c[4]} ${c[5]}<br>Phone: ${c[6]} | Email: ${c[7]}`;
  }

  const phone = ['Cell','Landline'][Math.floor(Math.random()*2)];
  byId('st-scenario').innerHTML = `<b>For this call you will portray ${caller}.</b> ${fname} would like to speak with a supervisor. The caller was ${reason.toLowerCase()} during a previous call.<br>• <b>Phone Type:</b> ${phone}`;
}

function setResult(res) {
  currentResult = res;
  byId('st-pass').className = `result-btn ${res === 'Pass' ? 'selected-pass' : ''}`;
  byId('st-fail').className = `result-btn ${res === 'Fail' ? 'selected-fail' : ''}`;
  byId('st-fail-card').style.display = res === 'Fail' ? 'block' : 'none';
}

async function validateAndContinue(content, footer) {
  if (!currentResult) { await modal.warning('Notice', 'Select PASS or FAIL.'); return; }
  if (currentResult === 'Fail') {
    if (!document.querySelector('#st-fail-grid input[type="checkbox"]:checked')) { await modal.warning('Notice', 'Select at least one Fail Reason.'); return; }
  }

  const data = {
    transfer_num: transferNum, result: currentResult,
    caller: byId('st-caller').value, show: byId('st-show').value, reason: byId('st-reason').value,
    coaching: gatherChecks('st-coaching-grid'), coach_notes: byId('st-coach-notes').value.trim(),
    fails: gatherChecks('st-fail-grid'), fail_notes: byId('st-fail-notes').value.trim(),
  };
  await api.saveSupTransfer(data);

  if (transferNum === 1) {
    if (currentResult === 'Pass') { location.hash = '#review'; }
    else { transferNum = 2; currentResult = null; buildScreen(content, footer); }
  } else {
    if (currentResult === 'Fail') {
      const { session } = await api.getCurrentSession();
      if (session.final_attempt) { await api.updateSession({ final_status: 'Fail' }); location.hash = '#review'; }
      else { location.hash = '#newbieshift'; }
    } else { location.hash = '#review'; }
  }
}

function buildGrid(id, items, notesId) {
  const grid = byId(id); const left = document.createElement('div'), right = document.createElement('div');
  const half = Math.ceil(items.length / 2);
  items.forEach((item, i) => {
    const col = i < half ? left : right; const g = document.createElement('div'); g.className = 'coaching-group';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.key = item.label;
    const lbl = document.createElement('label'); lbl.className = 'checkbox-label'; lbl.appendChild(cb); lbl.append(` ${item.label}`); g.appendChild(lbl);
    if (item.helper) { const h = document.createElement('div'); h.className = 'helper-text'; h.textContent = item.helper; g.appendChild(h); }
    if (item.children) { item.children.forEach(child => {
      const ccb = document.createElement('input'); ccb.type = 'checkbox'; ccb.disabled = true; ccb.dataset.key = `${item.label}_${child}`;
      const cl = document.createElement('label'); cl.className = 'checkbox-label sub-item disabled'; cl.appendChild(ccb); cl.append(` ${child}`); g.appendChild(cl);
      cb.addEventListener('change', () => { ccb.disabled = !cb.checked; cl.classList.toggle('disabled', !cb.checked); if (!cb.checked) ccb.checked = false; });
    }); }
    if (item.label === 'Other') cb.addEventListener('change', () => { byId(notesId).disabled = !cb.checked; });
    col.appendChild(g);
  }); grid.appendChild(left); grid.appendChild(right);
}

function buildFailList(id, items, notesId) {
  const grid = byId(id); const left = document.createElement('div'), right = document.createElement('div');
  const half = Math.ceil(items.length / 2);
  items.forEach((item, i) => {
    const col = i < half ? left : right;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.key = item;
    const lbl = document.createElement('label'); lbl.className = 'checkbox-label'; lbl.appendChild(cb); lbl.append(` ${item}`); col.appendChild(lbl);
    if (item === 'Other') cb.addEventListener('change', () => { byId(notesId).disabled = !cb.checked; });
  }); grid.appendChild(left); grid.appendChild(right);
}

function gatherChecks(id) { const r = {}; byId(id).querySelectorAll('input[type="checkbox"]').forEach(cb => { if (cb.dataset.key) r[cb.dataset.key] = cb.checked; }); return r; }
function byId(id) { return document.getElementById(id); }
