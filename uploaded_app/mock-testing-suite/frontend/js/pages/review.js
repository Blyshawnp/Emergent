/**
 * review.js — Session Review & Summary screen.
 * Calculates final status, generates summaries, provides form-fill and finish actions.
 */
import { api } from '../api.js';
import { modal } from '../modal.js';

let coachingText = '';
let failText = '';

export async function render(content, footer) {
  // Get current session
  let sessionData;
  try {
    const resp = await api.getCurrentSession();
    sessionData = resp.session;
  } catch {
    content.innerHTML = '<div class="stub-page"><h1>No Active Session</h1><p>Start a session from the Home screen.</p></div>';
    footer.innerHTML = '';
    return;
  }

  if (!sessionData || !sessionData.candidate_name) {
    content.innerHTML = '<div class="stub-page"><h1>No Active Session</h1><p>Start a session from the Home screen.</p></div>';
    footer.innerHTML = '';
    return;
  }

  const s = sessionData;
  const name = s.candidate_name || 'Unknown';
  const autoFail = s.auto_fail_reason;
  const supOnly = s.supervisor_only || false;

  // Calculate status
  const c1r = (s.call_1 || {}).result;
  const c2r = (s.call_2 || {}).result;
  const c3r = (s.call_3 || {}).result;
  const s1r = (s.sup_transfer_1 || {}).result;
  const s2r = (s.sup_transfer_2 || {}).result;

  const callsPassed = [c1r, c2r, c3r].filter(r => r === 'Pass').length;
  const supsPassed = [s1r, s2r].filter(r => r === 'Pass').length;
  const newbie = s.newbie_shift_data;

  let finalStatus = 'Fail';
  if (!autoFail) {
    if (supOnly) {
      if (supsPassed >= 1) finalStatus = 'Pass';
      else if (newbie) finalStatus = 'Incomplete';
    } else {
      if (callsPassed >= 2) {
        if (supsPassed >= 1) finalStatus = 'Pass';
        else if (newbie) finalStatus = 'Incomplete';
      }
    }
  }

  // Save final status to backend
  await api.updateSession({ final_status: finalStatus }).catch(() => {});

  // Generate summaries
  let summaries = { coaching: 'Generating...', fail: 'Generating...' };
  try {
    summaries = await api.generateSummaries();
  } catch (e) {
    summaries = { coaching: `Error: ${e.message}`, fail: `Error: ${e.message}` };
  }
  coachingText = summaries.coaching || '';
  failText = summaries.fail || '';

  // Banner
  let bannerClass, bannerText;
  if (finalStatus === 'Pass') {
    bannerClass = 'banner-pass';
    bannerText = '✅ SESSION PASSED';
  } else if (finalStatus === 'Incomplete') {
    bannerClass = 'banner-incomplete';
    bannerText = '⏳ SESSION INCOMPLETE — Pending Newbie Shift';
  } else {
    bannerClass = 'banner-fail';
    bannerText = autoFail ? `❌ AUTO-FAIL: ${autoFail.toUpperCase()}` : '❌ SESSION FAILED';
  }

  // Details breakdown
  let detailsHTML = `<strong style="font-size:var(--font-size-lg);color:var(--color-primary);">Candidate: ${esc(name)}</strong><br><br>`;
  detailsHTML += `<strong>Skills:</strong> ${supOnly ? 'Supervisor Transfer ONLY' : 'Mock Calls + Supervisor Transfer'}<br>`;
  if (autoFail) detailsHTML += `<strong>Auto-Fail:</strong> <span style="color:var(--color-danger);">${esc(autoFail)}</span><br>`;

  if (!supOnly) {
    detailsHTML += '<br><strong>— CALL RESULTS —</strong><br>';
    detailsHTML += `<strong>Call 1:</strong> ${colorResult(c1r)}<br>`;
    detailsHTML += `<strong>Call 2:</strong> ${colorResult(c2r)}<br>`;
    detailsHTML += `<strong>Call 3:</strong> ${colorResult(c3r)}<br>`;
  }

  detailsHTML += '<br><strong>— SUP TRANSFER RESULTS —</strong><br>';
  detailsHTML += `<strong>Transfer 1:</strong> ${colorResult(s1r)}<br>`;
  detailsHTML += `<strong>Transfer 2:</strong> ${colorResult(s2r)}<br>`;

  if (newbie) {
    detailsHTML += `<br><strong>— NEWBIE SHIFT —</strong><br>`;
    detailsHTML += `<strong>Date/Time:</strong> ${newbie.newbie_date || ''} at ${newbie.newbie_time || ''} ${newbie.newbie_tz || ''}<br>`;
  }

  content.innerHTML = `
    <h1 style="margin-bottom:var(--space-lg);">Session Review & Summary</h1>

    <div class="banner ${bannerClass}">${bannerText}</div>

    <div class="card" style="margin-top:var(--space-lg);">
      <div style="line-height:1.7;">${detailsHTML}</div>
    </div>

    <!-- Coaching Summary -->
    <div style="margin-top:var(--space-xl);">
      <h3 style="margin-bottom:var(--space-sm);">Coaching Summary</h3>
      <textarea id="review-coaching" class="review-textarea" rows="6">${esc(coachingText)}</textarea>
      <div class="review-btn-row">
        <button class="btn btn-primary btn-sm" id="btn-copy-coaching" data-tooltip="Copy coaching summary to clipboard">📋 Copy</button>
        <button class="btn btn-ghost btn-sm" id="btn-regen-coaching" data-tooltip="Regenerate using Gemini AI">🔄 Regenerate</button>
      </div>
    </div>

    <!-- Fail Summary -->
    <div style="margin-top:var(--space-lg);">
      <h3 style="margin-bottom:var(--space-sm);">Fail Summary</h3>
      <textarea id="review-fail" class="review-textarea" rows="6">${esc(failText)}</textarea>
      <div class="review-btn-row">
        <button class="btn btn-primary btn-sm" id="btn-copy-fail" data-tooltip="Copy fail summary to clipboard">📋 Copy</button>
        <button class="btn btn-ghost btn-sm" id="btn-regen-fail" data-tooltip="Regenerate using Gemini AI">🔄 Regenerate</button>
      </div>
    </div>
  `;

  // Footer
  footer.innerHTML = `
    <span class="spacer"></span>
    <button class="btn btn-warning" id="btn-fill-form" data-tooltip="Auto-fill the Cert Test Call Results Form in Chrome">📝 Fill Form</button>
    <button class="btn btn-success btn-lg" id="btn-finish" data-tooltip="Save to history, send to Sheets, and end the session">Save & Finish Session ✔</button>
  `;

  // Wire events
  byId('btn-copy-coaching').onclick = () => copyText(byId('review-coaching').value, byId('btn-copy-coaching'));
  byId('btn-copy-fail').onclick = () => copyText(byId('review-fail').value, byId('btn-copy-fail'));

  byId('btn-regen-coaching').onclick = async () => {
    byId('btn-regen-coaching').textContent = '⏳ Working...';
    byId('btn-regen-coaching').disabled = true;
    try {
      const r = await api.regenerateSummary('coaching');
      if (r.ok) byId('review-coaching').value = r.text;
      else await modal.error('Regeneration Failed', r.error || 'Unknown error'));
    } catch (e) { await modal.error('Error', e.message); }
    byId('btn-regen-coaching').textContent = '🔄 Regenerate';
    byId('btn-regen-coaching').disabled = false;
  };

  byId('btn-regen-fail').onclick = async () => {
    byId('btn-regen-fail').textContent = '⏳ Working...';
    byId('btn-regen-fail').disabled = true;
    try {
      const r = await api.regenerateSummary('fail');
      if (r.ok) byId('review-fail').value = r.text;
      else await modal.error('Regeneration Failed', r.error || 'Unknown error'));
    } catch (e) { await modal.error('Error', e.message); }
    byId('btn-regen-fail').textContent = '🔄 Regenerate';
    byId('btn-regen-fail').disabled = false;
  };

  byId('btn-fill-form').onclick = async () => {
    const btn = byId('btn-fill-form');
    btn.textContent = '⏳ Launching Chrome...';
    btn.disabled = true;
    try {
      const coaching = byId('review-coaching').value;
      const fail = byId('review-fail').value;
      const r = await api.fillForm(coaching, fail);
      if (r.ok) await modal.alert('Form Filled', r.message);
      else await modal.error('Form Fill Failed',<br><br>' + r.message);
    } catch (e) { await modal.error('Error', e.message); }
    btn.textContent = '📝 Fill Form';
    btn.disabled = false;
  };

  byId('btn-finish').onclick = async () => {
    if (!await modal.confirm('Finish Session', 'Save this session and finish?<br><br>This will save to history, send to Google Sheets (if enabled), and clear the current draft.', '💾')) return;

    const btn = byId('btn-finish');
    btn.textContent = '⏳ Saving...';
    btn.disabled = true;
    try {
      const coaching = byId('review-coaching').value;
      const fail = byId('review-fail').value;
      const r = await api.finishSession(coaching, fail, false);
      if (r.ok) {
        await modal.alert('Session Saved', 'Your session has been saved successfully!');
        location.hash = '#home';
      } else {
        await modal.error('Error', (r.error || 'Unknown'));
        btn.textContent = 'Save & Finish Session ✔';
        btn.disabled = false;
      }
    } catch (e) {
      await modal.error('Error', e.message);
      btn.textContent = 'Save & Finish Session ✔';
      btn.disabled = false;
    }
  };
}

// Helpers
function byId(id) { return document.getElementById(id); }

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function colorResult(r) {
  if (r === 'Pass') return '<span style="color:var(--color-success);font-weight:700;">PASS</span>';
  if (r === 'Fail') return '<span style="color:var(--color-danger);font-weight:700;">FAIL</span>';
  return '<span style="color:var(--text-tertiary);">Did Not Take</span>';
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  });
}
