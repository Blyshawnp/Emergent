/**
 * newbieshift.js — Schedule a follow-up Newbie Shift.
 */
import { api } from '../api.js';
import { modal } from '../modal.js';

export async function render(content, footer) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const defaultDate = tomorrow.toISOString().split('T')[0];

  content.innerHTML = `
    <h1 style="margin-bottom:var(--space-lg);">Schedule Newbie Shift</h1>

    <div class="card" style="padding:var(--space-2xl);">
      <div style="display:flex;gap:var(--space-xl);justify-content:center;flex-wrap:wrap;">
        <div>
          <label class="text-sm font-bold text-muted" style="display:block;margin-bottom:6px;">DATE</label>
          <input type="date" id="ns-date" value="${defaultDate}" style="max-width:180px;">
        </div>
        <div>
          <label class="text-sm font-bold text-muted" style="display:block;margin-bottom:6px;">START TIME</label>
          <div style="display:flex;gap:6px;">
            <input type="text" id="ns-time" placeholder="e.g. 1030" style="max-width:110px;">
            <select id="ns-ampm" style="max-width:70px;"><option>AM</option><option>PM</option></select>
          </div>
        </div>
        <div>
          <label class="text-sm font-bold text-muted" style="display:block;margin-bottom:6px;">TIMEZONE</label>
          <select id="ns-tz" style="max-width:200px;">
            <option>EST (Eastern)</option><option>CST (Central)</option><option>MST (Mountain)</option><option>PST (Pacific)</option>
          </select>
        </div>
      </div>
    </div>

    <div style="margin-top:var(--space-lg);">
      <button class="btn btn-primary" id="ns-gcal" data-tooltip="Create a Google Calendar event for this shift">📅 Add to Google Calendar</button>
    </div>
  `;

  // Google Calendar link
  byId('ns-gcal').onclick = () => {
    const d = gatherData();
    if (!d) return;
    const dateStr = byId('ns-date').value.replace(/-/g, '');
    const title = encodeURIComponent('Newbie Shift - Supervisor Transfer');
    const details = encodeURIComponent(`Mock Testing Suite - Newbie Shift<br>Time: ${d.newbie_time}<br>Timezone: ${d.newbie_tz}`);
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dateStr}/${dateStr}&details=${details}`;
    window.open(url, '_blank');
  };

  // Footer
  footer.innerHTML = `
    <button class="btn btn-muted btn-sm" id="ns-discard">Discard</button>
    <button class="btn btn-danger btn-sm" id="ns-stopped">⚠ Stopped Responding</button>
    <button class="btn btn-muted btn-sm" id="ns-tech">🛠 Tech</button>
    <span class="spacer"></span>
    <button class="btn btn-primary" id="ns-continue">Continue to Review</button>
  `;

  byId('ns-discard').onclick = async () => {
    if (await modal.confirm('Confirm', 'Discard session and lose all progress?')) { await api.discardSession(); location.hash = '#home'; }
  };
  byId('ns-stopped').onclick = async () => {
    await api.updateSession({ auto_fail_reason: 'Stopped Responding in Chat', final_status: 'Fail' });
    location.hash = '#review';
  };
  byId('ns-tech').onclick = () => await modal.warning('Notice', 'Tech Issue logged.');
  byId('ns-continue').onclick = async () => {
    const d = gatherData();
    if (!d) return;
    await api.updateSession({ newbie_shift_data: d });
    location.hash = '#review';
  };
}

function gatherData() {
  const raw = byId('ns-time').value.trim().replace(/\D/g, '');
  if (raw.length < 3 || raw.length > 4) { await modal.warning('Notice', 'Enter a valid time (e.g. 1030 or 945).'); return null; }
  const formatted = raw.length === 3 ? `${raw[0]}:${raw.slice(1)}` : `${raw.slice(0,2)}:${raw.slice(2)}`;

  const dateVal = byId('ns-date').value;
  const parts = dateVal.split('-');
  const mmddyyyy = `${parts[1]}/${parts[2]}/${parts[0]}`;

  return {
    newbie_date: mmddyyyy,
    newbie_time: `${formatted} ${byId('ns-ampm').value}`,
    newbie_tz: byId('ns-tz').value,
  };
}

function byId(id) { return document.getElementById(id); }
