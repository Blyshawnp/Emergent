/**
 * calls.js — Mock Calls screen.
 * Grades up to 3 calls with call type, show, caller, coaching, and fail reasons.
 * Implements 2-pass/2-fail routing logic.
 */
import { api } from '../api.js';
import { modal } from '../modal.js';

let callNum = 1;
let currentResult = null;
let defaults = {};
let settings = {};
let randFlags = {};

const CALL_COACHING = [
  { id: 'c-show-app', label: 'Show appreciation', children: ['For Current/Existing Donors', 'After donation amount is given'] },
  { id: 'c-phonetics', label: 'Phonetics table provided to candidate' },
  { id: 'c-dontask', label: "Don't Ask, Just Verify Address and Phone Number", helper: 'Existing member already provided address and phone number' },
  { id: 'c-verify', label: 'Verification', children: ['Name', 'Address', 'Phone', 'Email', 'Card/EFT', 'Phonetics for Sound Alike Letters'] },
  { id: 'c-verbatim', label: 'Read script verbatim', helper: 'No adlibbing or skipping sections' },
  { id: 'c-nav', label: 'Use effective script navigation', children: ['Scroll down to avoid missing parts of the script', 'Use the Back and Next buttons and not the Icons'] },
  { id: 'c-other', label: 'Other' },
];

const CALL_FAILS = [
  'Skipped parts of script', 'Volunteered info', 'Wrong donation', 'Background noise on call',
  'Paraphrased script', 'Wrong thank you gift', 'Script navigation issues', 'Other',
];

export async function render(content, footer) {
  try {
    [defaults, settings] = await Promise.all([api.getDefaults(), api.getSettings()]);
  } catch { defaults = {}; settings = {}; }

  callNum = 1;
  currentResult = null;
  rollRandom();
  buildCallScreen(content, footer);
}

function rollRandom() {
  const pick = a => a[Math.floor(Math.random() * a.length)];
  randFlags = { phone: pick(['Cell','Landline']), text: pick(['Yes','No']), enews: pick(['Yes','No']), ship: pick(['Yes','No']), ccfee: pick(['Yes','No']) };
}

function buildCallScreen(content, footer) {
  const shows = settings.shows || defaults.shows || [];
  const callTypes = settings.call_types || defaults.call_types || [];

  content.innerHTML = `
    <h1 style="margin-bottom:var(--space-lg);">Call #${callNum}</h1>

    <div class="split-layout">
      <!-- Setup -->
      <div class="card">
        <h3 style="margin-bottom:var(--space-md);">Call Setup</h3>
        <div class="form-row"><label>Call Type</label><select id="cl-type" style="max-width:350px;">${callTypes.map(t => `<option>${t}</option>`).join('')}</select></div>
        <div class="form-row"><label>Show</label><select id="cl-show" style="max-width:350px;">${shows.map(s => `<option>${s[0]}</option>`).join('')}</select></div>
        <div class="form-row"><label>Caller</label><select id="cl-caller" style="max-width:250px;"></select></div>
        <div class="form-row"><label>Donation</label><select id="cl-donation" style="max-width:150px;"></select></div>
      </div>
      <!-- Scenario -->
      <div class="card card-scenario">
        <h3 style="color:var(--border-scenario);margin-bottom:var(--space-sm);">SCENARIO</h3>
        <div id="cl-scenario" style="line-height:1.7;">Select call type, show, and caller.</div>
      </div>
    </div>

    <!-- Payment Sim -->
    <div class="card" style="margin-bottom:var(--space-md);">
      <h3 style="margin-bottom:var(--space-sm);">Payment Simulation</h3>
      <div class="payment-grid">
        <div class="payment-card payment-card-cc">
          <div style="font-weight:700;font-size:12px;margin-bottom:6px;">💳 AMERICAN EXPRESS</div>
          <div class="font-mono font-bold" style="font-size:18px;letter-spacing:2px;">3782 822463 10005</div>
          <div style="font-weight:600;font-size:13px;margin-top:4px;">EXP: 07/2027 &nbsp; CVV: 1928</div>
        </div>
        <div class="payment-card payment-card-eft">
          <div style="font-weight:700;font-size:12px;margin-bottom:6px;">🏦 EFT / BANK DRAFT</div>
          <div class="font-mono font-bold" style="font-size:15px;">RTN: 021000021</div>
          <div class="font-mono font-bold" style="font-size:15px;">ACC: 1357902468</div>
        </div>
      </div>
    </div>

    <!-- Demographics -->
    <div class="card" style="margin-bottom:var(--space-md);">
      <h3 style="margin-bottom:var(--space-sm);">Caller Demographics</h3>
      <div id="cl-demo" style="text-align:center;">Select a caller to view demographics.</div>
    </div>

    <!-- Result -->
    <div class="card" style="margin-bottom:var(--space-md);">
      <h3 style="margin-bottom:var(--space-sm);">Call Result</h3>
      <div class="result-btns">
        <button class="result-btn" id="cl-pass">☑ PASS</button>
        <button class="result-btn" id="cl-fail">✖ FAIL</button>
      </div>
    </div>

    <!-- Coaching -->
    <div class="card" style="margin-bottom:var(--space-md);">
      <h3>Coaching Given</h3>
      <p class="text-muted text-sm" style="margin-bottom:var(--space-md);">One or more may be selected</p>
      <div class="coaching-grid" id="cl-coaching-grid"></div>
      <div style="margin-top:var(--space-md);">
        <label class="text-sm font-bold">Other Coaching Notes</label>
        <textarea id="cl-coach-notes" rows="2" disabled style="margin-top:4px;"></textarea>
      </div>
    </div>

    <!-- Fail Reasons (hidden until Fail selected) -->
    <div class="card card-fail" id="cl-fail-card" style="display:none;margin-bottom:var(--space-md);">
      <h3 style="color:var(--color-danger);">⚠ Fail Reasons</h3>
      <p class="text-muted text-sm" style="margin-bottom:var(--space-md);">One or more may be selected</p>
      <div class="coaching-grid" id="cl-fail-grid"></div>
      <div style="margin-top:var(--space-md);">
        <label class="text-sm font-bold">Other Fail Notes</label>
        <textarea id="cl-fail-notes" rows="2" disabled style="margin-top:4px;"></textarea>
      </div>
    </div>
  `;

  // Build coaching checkboxes
  buildCoachingGrid('cl-coaching-grid', CALL_COACHING, 'cl-coach-notes', 'c-other');
  buildFailGrid('cl-fail-grid', CALL_FAILS, 'cl-fail-notes');

  // Wire dropdowns
  const typeEl = byId('cl-type'), showEl = byId('cl-show'), callerEl = byId('cl-caller'), donationEl = byId('cl-donation');
  typeEl.onchange = () => { rollRandom(); filterCallers(); };
  showEl.onchange = () => updateDonations();
  callerEl.onchange = () => { rollRandom(); updateScenario(); };
  donationEl.onchange = () => updateScenario();
  filterCallers();

  // Result buttons
  byId('cl-pass').onclick = () => setResult('Pass');
  byId('cl-fail').onclick = () => setResult('Fail');

  // Footer
  footer.innerHTML = `
    <button class="btn btn-muted btn-sm" id="cl-back">← Back</button>
    <button class="btn btn-danger btn-sm" id="cl-stopped">⚠ Stopped Responding</button>
    <button class="btn btn-muted btn-sm" id="cl-tech">🛠 Tech</button>
    <span class="spacer"></span>
    <button class="btn btn-primary" id="cl-continue">Continue →</button>
  `;

  byId('cl-back').onclick = () => {
    if (callNum > 1) { callNum--; rollRandom(); buildCallScreen(content, footer); }
    else location.hash = '#basics';
  };
  byId('cl-stopped').onclick = async () => {
    await api.updateSession({ auto_fail_reason: 'Stopped Responding in Chat', final_status: 'Fail' });
    location.hash = '#review';
  };
  byId('cl-tech').onclick = () => await modal.warning('Notice', 'Tech Issue logging — session continues.');
  byId('cl-continue').onclick = () => validateAndContinue(content, footer);
}

function filterCallers() {
  const ct = byId('cl-type').value.toLowerCase();
  let callers;
  if (ct.includes('increase')) callers = settings.donors_increase || defaults.donors_increase || [];
  else if (ct.includes('new')) callers = settings.donors_new || defaults.donors_new || [];
  else callers = settings.donors_existing || defaults.donors_existing || [];

  const el = byId('cl-caller');
  el.innerHTML = callers.map(c => `<option>${c[0]} ${c[1]}</option>`).join('');
  window._currentCallers = callers;
  updateDonations();
}

function updateDonations() {
  const shows = settings.shows || defaults.shows || [];
  const showName = byId('cl-show').value;
  const ct = byId('cl-type').value.toLowerCase();
  const isMonthly = !ct.includes('one time');

  const show = shows.find(s => s[0] === showName);
  const el = byId('cl-donation');
  el.innerHTML = '';
  if (show) {
    const amt = isMonthly ? show[2] : show[1];
    if (amt) el.innerHTML += `<option>${amt}</option>`;
  }
  el.innerHTML += '<option>Other</option>';
  updateScenario();
}

function updateScenario() {
  const ct = byId('cl-type').value;
  const caller = byId('cl-caller').value;
  const show = byId('cl-show').value;
  const donation = byId('cl-donation').value;
  const fname = caller.split(' ')[0];
  const callers = window._currentCallers || [];
  const idx = byId('cl-caller').selectedIndex;

  // Update demographics
  if (idx >= 0 && idx < callers.length) {
    const c = callers[idx];
    byId('cl-demo').innerHTML = `<b>${c[0]} ${c[1]}</b><br>${c[2]}, ${c[3]}, ${c[4]} ${c[5]}<br>Phone: ${c[6]} | Email: ${c[7]}`;
  }

  const isSustaining = ct.toLowerCase().includes('sustaining') || ct.toLowerCase().includes('monthly') || ct.toLowerCase().includes('increase');
  const donorType = ct.toLowerCase().includes('new') ? 'a new donor' : 'an existing member';
  let action = 'make a one-time donation of';
  if (ct.toLowerCase().includes('increase')) action = 'increase their sustaining donation to';
  else if (isSustaining) action = 'start a new sustaining donation of';

  let html = `<b>For this call you will portray ${caller}.</b> ${fname} is ${donorType} wishing to ${action} ${donation} to support ${show}.<br><br>`;
  html += `• <b>Phone Type:</b> ${randFlags.phone}<br>`;
  if (randFlags.phone === 'Cell') html += `• <b>Text Messages:</b> ${randFlags.text}<br>`;
  html += `• <b>E-Newsletter:</b> ${randFlags.enews}<br>`;
  html += `• <b>Cover $6 Shipping:</b> ${randFlags.ship}<br>`;
  if (isSustaining) html += `• <b>Cover $2 CC Fee:</b> ${randFlags.ccfee}`;

  byId('cl-scenario').innerHTML = html;
}

function setResult(res) {
  currentResult = res;
  byId('cl-pass').className = `result-btn ${res === 'Pass' ? 'selected-pass' : ''}`;
  byId('cl-fail').className = `result-btn ${res === 'Fail' ? 'selected-fail' : ''}`;
  byId('cl-fail-card').style.display = res === 'Fail' ? 'block' : 'none';
}

async function validateAndContinue(content, footer) {
  if (!currentResult) { await modal.warning('Notice', 'You must select PASS or FAIL.'); return; }

  if (currentResult === 'Fail') {
    const hasFailChecked = document.querySelectorAll('#cl-fail-grid input[type="checkbox"]:checked').length > 0;
    if (!hasFailChecked) { await modal.warning('Notice', 'You must select at least one Fail Reason.'); return; }
    const otherCb = document.querySelector('#cl-fail-grid input[data-key="Other"]');
    if (otherCb && otherCb.checked && !byId('cl-fail-notes').value.trim()) { await modal.warning('Notice', 'You selected "Other" — please provide notes.'); return; }
  }

  // Save call data
  const callData = {
    call_num: callNum,
    result: currentResult,
    type: byId('cl-type').value,
    show: byId('cl-show').value,
    caller: byId('cl-caller').value,
    donation: byId('cl-donation').value,
    coaching: gatherChecks('cl-coaching-grid'),
    coach_notes: byId('cl-coach-notes').value.trim(),
    fails: gatherChecks('cl-fail-grid'),
    fail_notes: byId('cl-fail-notes').value.trim(),
  };
  await api.saveCall(callData);

  // Get full session to check routing
  const { session } = await api.getCurrentSession();

  let passes = [], fails = 0;
  for (let i = 1; i <= 3; i++) {
    const c = session[`call_${i}`];
    if (c && c.result === 'Pass') passes.push(c.type || '');
    else if (c && c.result === 'Fail') fails++;
  }

  // 2 passes: check type mix
  if (passes.length === 2) {
    const hasNew = passes.some(t => t.toLowerCase().includes('new'));
    const hasExt = passes.some(t => t.toLowerCase().includes('existing'));
    if (!hasNew || !hasExt) {
      const missing = hasNew ? 'Existing Member' : 'New Donor';
      await modal.warning("Call Type Error", `You must pass one New Donor and one Existing Member call.<br><br>Change this call's type to a "${missing}" scenario.`);
      return;
    }
  }

  // 2 fails → session over
  if (fails >= 2) {
    await api.updateSession({ final_status: 'Fail' });
    await modal.warning('Notice', 'The candidate has failed 2 calls. Proceeding to Review.');
    location.hash = '#review';
    return;
  }

  // 2 passes → sup transfer
  if (passes.length >= 2) {
    if (await modal.confirm('Confirm', 'Is there enough time for Supervisor Transfers?')) {
      await api.updateSession({ time_for_sup: true });
      location.hash = '#suptransfer';
    } else {
      await api.updateSession({ time_for_sup: false });
      location.hash = '#newbieshift';
    }
    return;
  }

  // Next call
  callNum++;
  currentResult = null;
  rollRandom();
  buildCallScreen(content, footer);
}

// Shared helpers
function buildCoachingGrid(containerId, items, notesId, otherKey) {
  const grid = byId(containerId);
  const left = document.createElement('div'), right = document.createElement('div');
  const half = Math.ceil(items.length / 2);

  items.forEach((item, i) => {
    const col = i < half ? left : right;
    const group = document.createElement('div');
    group.className = 'coaching-group';

    const parentCb = document.createElement('input');
    parentCb.type = 'checkbox';
    parentCb.dataset.key = item.label;
    const parentLabel = document.createElement('label');
    parentLabel.className = 'checkbox-label';
    parentLabel.appendChild(parentCb);
    parentLabel.append(` ${item.label}`);
    group.appendChild(parentLabel);

    if (item.helper) {
      const h = document.createElement('div');
      h.className = 'helper-text';
      h.textContent = item.helper;
      group.appendChild(h);
    }

    if (item.children) {
      item.children.forEach(child => {
        const childCb = document.createElement('input');
        childCb.type = 'checkbox';
        childCb.disabled = true;
        childCb.dataset.key = `${item.label}_${child}`;
        const childLabel = document.createElement('label');
        childLabel.className = 'checkbox-label sub-item disabled';
        childLabel.appendChild(childCb);
        childLabel.append(` ${child}`);
        group.appendChild(childLabel);

        parentCb.addEventListener('change', () => {
          childCb.disabled = !parentCb.checked;
          childLabel.classList.toggle('disabled', !parentCb.checked);
          if (!parentCb.checked) childCb.checked = false;
        });
      });
    }

    if (item.id === otherKey || item.label === 'Other') {
      parentCb.addEventListener('change', () => { byId(notesId).disabled = !parentCb.checked; });
    }

    col.appendChild(group);
  });

  grid.appendChild(left);
  grid.appendChild(right);
}

function buildFailGrid(containerId, items, notesId) {
  const grid = byId(containerId);
  const left = document.createElement('div'), right = document.createElement('div');
  const half = Math.ceil(items.length / 2);

  items.forEach((item, i) => {
    const col = i < half ? left : right;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.key = item;
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    label.appendChild(cb);
    label.append(` ${item}`);
    col.appendChild(label);

    if (item === 'Other') {
      cb.addEventListener('change', () => { byId(notesId).disabled = !cb.checked; });
    }
  });

  grid.appendChild(left);
  grid.appendChild(right);
}

function gatherChecks(containerId) {
  const result = {};
  byId(containerId).querySelectorAll('input[type="checkbox"]').forEach(cb => {
    if (cb.dataset.key) result[cb.dataset.key] = cb.checked;
  });
  return result;
}

function byId(id) { return document.getElementById(id); }
