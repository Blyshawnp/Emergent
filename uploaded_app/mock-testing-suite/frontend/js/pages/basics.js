/**
 * basics.js — The Basics screen.
 * Compact layout that fits the window without scrolling.
 */
import { api } from '../api.js';
import { modal } from '../modal.js';

export async function render(content, footer) {
  let settings;
  try { settings = await api.getSettings(); } catch { settings = {}; }
  const testerName = settings.tester_name || '';

  content.innerHTML = `
    <h1 style="margin-bottom:var(--space-md);">The Basics</h1>

    <!-- Session Info -->
    <div class="card" style="margin-bottom:var(--space-sm);padding:var(--space-md) var(--space-lg);">
      <h3 style="margin-bottom:var(--space-sm);">Session Information</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm) var(--space-lg);align-items:center;">
        <div style="display:flex;align-items:center;gap:var(--space-sm);">
          <label class="text-sm font-bold" style="min-width:110px;">Tester</label>
          <input type="text" id="b-tester" value="${esc(testerName)}" readonly style="flex:1;opacity:0.7;">
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-sm);">
          <label class="text-sm font-bold" style="min-width:130px;">Candidate Name</label>
          <input type="text" id="b-candidate" placeholder="Required" style="flex:1;">
        </div>
        <div style="display:flex;align-items:center;gap:var(--space-sm);">
          <label class="text-sm font-bold" style="min-width:110px;">Pronouns</label>
          <select id="b-pronoun" style="width:100px;"><option value=""></option><option>She</option><option>He</option><option>They</option></select>
        </div>
        <div>
          <label class="checkbox-label"><input type="checkbox" id="b-final"> <span style="color:var(--color-danger);font-weight:700;">FINAL ATTEMPT</span></label>
        </div>
      </div>
    </div>

    <!-- Headset -->
    <div class="card" style="margin-bottom:var(--space-sm);padding:var(--space-md) var(--space-lg);">
      <h3 style="margin-bottom:var(--space-sm);">Headset Requirements</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--space-sm) var(--space-lg);align-items:center;">
        <div>
          <label class="text-sm font-bold text-muted" style="display:block;margin-bottom:4px;">USB Headset?</label>
          <div class="radio-group"><label class="radio-label"><input type="radio" name="b-usb" value="yes"> Yes</label><label class="radio-label"><input type="radio" name="b-usb" value="no"> No</label></div>
        </div>
        <div>
          <label class="text-sm font-bold text-muted" style="display:block;margin-bottom:4px;">Noise Cancelling?</label>
          <div class="radio-group"><label class="radio-label"><input type="radio" name="b-noise" value="yes"> Yes</label><label class="radio-label"><input type="radio" name="b-noise" value="no"> No</label></div>
        </div>
        <div>
          <label class="text-sm font-bold text-muted" style="display:block;margin-bottom:4px;">Brand / Model</label>
          <input type="text" id="b-brand" placeholder="e.g. Logitech H390">
        </div>
      </div>
    </div>

    <!-- VPN + Browser -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-sm);">
      <div class="card" style="padding:var(--space-md) var(--space-lg);">
        <h3 style="margin-bottom:var(--space-sm);">VPN</h3>
        <div style="display:flex;flex-direction:column;gap:var(--space-sm);">
          <div style="display:flex;align-items:center;gap:var(--space-md);">
            <label class="text-sm font-bold" style="min-width:110px;">Has VPN?</label>
            <div class="radio-group"><label class="radio-label"><input type="radio" name="b-vpn" value="yes"> Yes</label><label class="radio-label"><input type="radio" name="b-vpn" value="no"> No</label></div>
          </div>
          <div id="vpn-off-row" style="display:flex;align-items:center;gap:var(--space-md);opacity:0.3;pointer-events:none;">
            <label class="text-sm font-bold" style="min-width:110px;">Can turn off?</label>
            <div class="radio-group"><label class="radio-label"><input type="radio" name="b-vpnoff" value="yes"> Yes</label><label class="radio-label"><input type="radio" name="b-vpnoff" value="no"> No</label></div>
          </div>
        </div>
      </div>
      <div class="card" style="padding:var(--space-md) var(--space-lg);">
        <h3 style="margin-bottom:var(--space-sm);">Browser</h3>
        <div style="display:flex;flex-direction:column;gap:var(--space-sm);">
          <div style="display:flex;align-items:center;gap:var(--space-md);">
            <label class="text-sm font-bold" style="min-width:130px;">Default browser?</label>
            <div class="radio-group"><label class="radio-label"><input type="radio" name="b-chrome" value="yes"> Yes</label><label class="radio-label"><input type="radio" name="b-chrome" value="no"> No</label></div>
          </div>
          <div style="display:flex;align-items:center;gap:var(--space-md);">
            <label class="text-sm font-bold" style="min-width:130px;">Extensions off?</label>
            <div class="radio-group"><label class="radio-label"><input type="radio" name="b-ext" value="yes"> Yes</label><label class="radio-label"><input type="radio" name="b-ext" value="no"> No</label></div>
          </div>
          <div style="display:flex;align-items:center;gap:var(--space-md);">
            <label class="text-sm font-bold" style="min-width:130px;">Pop-ups allowed?</label>
            <div class="radio-group"><label class="radio-label"><input type="radio" name="b-popups" value="yes"> Yes</label><label class="radio-label"><input type="radio" name="b-popups" value="no"> No</label></div>
          </div>
        </div>
      </div>
    </div>
  `;

  // VPN conditional
  document.querySelectorAll('input[name="b-vpn"]').forEach(r => {
    r.addEventListener('change', () => {
      const row = document.getElementById('vpn-off-row');
      if (r.value === 'yes') { row.style.opacity = '1'; row.style.pointerEvents = 'auto'; }
      else { row.style.opacity = '0.3'; row.style.pointerEvents = 'none'; document.querySelectorAll('input[name="b-vpnoff"]').forEach(x => x.checked = false); }
    });
  });

  // Footer
  footer.innerHTML = `
    <button class="btn btn-danger btn-sm" id="b-ncns" data-tooltip="No Call / No Show">NC / NS</button>
    <button class="btn btn-danger btn-sm" id="b-notready" data-tooltip="Candidate not ready">Not Ready</button>
    <button class="btn btn-danger btn-sm" id="b-stopped" data-tooltip="Stopped responding in chat">⚠ Stopped Responding</button>
    <button class="btn btn-muted btn-sm" id="b-tech" data-tooltip="Log a technical issue">🛠 Tech Issue</button>
    <span class="spacer"></span>
    <button class="btn btn-primary" id="b-continue">Continue →</button>
  `;

  const autoFail = async (reason) => {
    const data = gatherData();
    if (!data.candidate_name) { await modal.warning('Missing Info', 'Enter the Candidate Name first.'); return; }
    data.auto_fail_reason = reason;
    data.final_status = 'Fail';
    await api.startSession(data);
    location.hash = '#review';
  };

  byId('b-ncns').onclick = () => autoFail('NC/NS');
  byId('b-notready').onclick = () => autoFail('Not ready for session');
  byId('b-stopped').onclick = () => autoFail('Stopped Responding in Chat');
  byId('b-tech').onclick = () => modal.alert('Tech Issue', 'Tech Issue logging will be fully implemented in the next update.');

  byId('b-continue').onclick = async () => {
    const d = gatherData();

    if (!d.candidate_name) { await modal.warning('Missing Info', 'Candidate Name is required.'); return; }
    if (d.headset_usb === null || d.noise_cancel === null || !d.headset_brand) { await modal.warning('Missing Info', 'All Headset fields are required.'); return; }
    if (d.vpn_on === null) { await modal.warning('Missing Info', 'VPN question must be answered.'); return; }
    if (d.vpn_on && d.vpn_off === null) { await modal.warning('Missing Info', 'Please confirm if the candidate can turn off their VPN.'); return; }
    if (d.chrome_default === null || d.extensions_disabled === null || d.popups_allowed === null) { await modal.warning('Missing Info', 'All Browser questions must be answered.'); return; }

    // Headset auto-fail
    if (d.headset_usb === false || d.noise_cancel === false) {
      const reasons = [];
      if (!d.headset_usb) reasons.push('Wrong headset (not USB)');
      if (!d.noise_cancel) reasons.push('Wrong headset (not noise cancelling)');
      const yes = await modal.confirm('Headset Issue',
        `To contract with ACD, a USB headset with a noise cancelling microphone must be used.<br><br>Fail session for: <b>${reasons.join(' and ')}</b>?`, '🎧');
      if (yes) { d.auto_fail_reason = reasons.join(' and '); d.final_status = 'Fail'; await api.startSession(d); location.hash = '#review'; }
      return;
    }

    // VPN auto-fail
    if (d.vpn_on && d.vpn_off === false) {
      const yes = await modal.confirm('VPN Issue',
        'Using a VPN is not accepted when contracting with ACD. The candidate cannot turn it off.<br><br>Fail this session?', '🔒');
      if (yes) { d.auto_fail_reason = 'Unable to turn off VPN'; d.final_status = 'Fail'; await api.startSession(d); location.hash = '#review'; }
      return;
    }

    // Browser issues
    if (d.chrome_default === false) {
      const fixed = await modal.confirm('Browser Issue',
        'The browser must be set as default so that DTE login functions properly.<br><br>Were they able to fix it?', '🌐');
      if (!fixed) { d.auto_fail_reason = 'Not ready for session (incorrect settings)'; d.final_status = 'Fail'; await api.startSession(d); location.hash = '#review'; return; }
    }
    if (d.extensions_disabled === false) {
      const fixed = await modal.confirm('Browser Issue',
        'Browser extensions must be disabled so they do not interfere with the script.<br><br>Were they able to fix it?', '🌐');
      if (!fixed) { d.auto_fail_reason = 'Not ready for session (incorrect settings)'; d.final_status = 'Fail'; await api.startSession(d); location.hash = '#review'; return; }
    }
    if (d.popups_allowed === false) {
      const fixed = await modal.confirm('Browser Issue',
        'Necessary pop-ups must be allowed so the script can pop correctly.<br><br>Were they able to fix it?', '🌐');
      if (!fixed) { d.auto_fail_reason = 'Not ready for session (incorrect settings)'; d.final_status = 'Fail'; await api.startSession(d); location.hash = '#review'; return; }
    }

    await api.startSession(d);
    location.hash = '#calls';
  };
}

function gatherData() {
  return {
    candidate_name: byId('b-candidate').value.trim(),
    tester_name: byId('b-tester').value.trim(),
    pronoun: byId('b-pronoun').value,
    final_attempt: byId('b-final').checked,
    headset_usb: radio('b-usb'), noise_cancel: radio('b-noise'),
    headset_brand: byId('b-brand').value.trim(),
    vpn_on: radio('b-vpn'), vpn_off: radio('b-vpnoff'),
    chrome_default: radio('b-chrome'), extensions_disabled: radio('b-ext'),
    popups_allowed: radio('b-popups'),
  };
}

function byId(id) { return document.getElementById(id); }
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function radio(name) { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value === 'yes' : null; }
