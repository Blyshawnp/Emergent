import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import TechIssueDialog from '../components/TechIssueDialog';

export default function NewbieShiftPage({ onNavigate }) {
  const modal = useModal();
  const [techOpen, setTechOpen] = useState(false);
  const [isFinal, setIsFinal] = useState(false);
  const [candidateName, setCandidateName] = useState('');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const [date, setDate] = useState(tomorrow.toISOString().split('T')[0]);
  const [time, setTime] = useState('');
  const [ampm, setAmpm] = useState('AM');
  const [tz, setTz] = useState('EST (Eastern)');

  useEffect(() => {
    let cancelled = false;
    api.getCurrentSession().then(({ session }) => {
      if (!cancelled && session) {
        setIsFinal(session.final_attempt || false);
        setCandidateName(session.candidate_name || '');
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Format time input to include colon
  const handleTimeChange = useCallback((val) => {
    // Strip non-digits
    const digits = val.replace(/\D/g, '').slice(0, 4);
    if (digits.length <= 2) {
      setTime(digits);
    } else {
      setTime(`${digits.slice(0, digits.length - 2)}:${digits.slice(-2)}`);
    }
  }, []);

  const getFormattedTime = useCallback(() => {
    const raw = time.replace(/\D/g, '');
    if (raw.length < 3 || raw.length > 4) return null;
    const formatted = raw.length === 3 ? `${raw[0]}:${raw.slice(1)}` : `${raw.slice(0, 2)}:${raw.slice(2)}`;
    return `${formatted} ${ampm}`;
  }, [time, ampm]);

  const getFormattedDate = useCallback(() => {
    const parts = date.split('-');
    return `${parts[1]}/${parts[2]}/${parts[0]}`;
  }, [date]);

  const getCalendarTitle = useCallback(() => {
    if (!candidateName) return 'Supervisor Test Call';
    const parts = candidateName.trim().split(/\s+/);
    const first = parts[0] || '';
    const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] + '.' : '';
    return `Supervisor Test Call - ${first} ${lastInitial}`.trim();
  }, [candidateName]);

  const handleGcal = useCallback(() => {
    const ft = getFormattedTime();
    if (!ft) { modal.warning('Notice', 'Enter a valid time (e.g. 10:30 or 9:45).'); return; }
    const dateStr = date.replace(/-/g, '');
    const title = encodeURIComponent(getCalendarTitle());
    const details = encodeURIComponent(`Mock Testing Suite - Newbie Shift\nTime: ${ft}\nTimezone: ${tz}`);
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dateStr}/${dateStr}&details=${details}`;
    window.open(url, '_blank');
  }, [date, tz, modal, getFormattedTime, getCalendarTitle]);

  const handleContinue = useCallback(async () => {
    const ft = getFormattedTime();
    if (!ft) { await modal.warning('Notice', 'Enter a valid time (e.g. 10:30 or 9:45).'); return; }
    const fd = getFormattedDate();
    await api.updateSession({ newbie_shift_data: { newbie_date: fd, newbie_time: ft, newbie_tz: tz } });
    onNavigate('review');
  }, [getFormattedTime, getFormattedDate, tz, modal, onNavigate]);

  return (
    <div data-testid="newbieshift-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <h1 style={{ marginBottom: 0 }}>Schedule Newbie Shift</h1>
        {candidateName && (
          <div className="text-sm text-muted" style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
            <b>Candidate:</b> {candidateName}
          </div>
        )}
      </div>
      <div className="card" style={{ padding: 48 }}>
        <div style={{ display: 'flex', gap: 32, justifyContent: 'center', flexWrap: 'wrap' }}>
          <div>
            <label className="text-sm font-bold text-muted" style={{ display: 'block', marginBottom: 6 }}>DATE</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ maxWidth: 200 }} data-testid="newbie-date" />
            <div className="text-xs text-muted" style={{ marginTop: 4 }}>Format: MM/DD/YYYY</div>
          </div>
          <div>
            <label className="text-sm font-bold text-muted" style={{ display: 'block', marginBottom: 6 }}>START TIME</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" value={time} onChange={e => handleTimeChange(e.target.value)} placeholder="H:MM" style={{ maxWidth: 90 }} data-testid="newbie-time" />
              <select value={ampm} onChange={e => setAmpm(e.target.value)} style={{ maxWidth: 70 }} data-testid="newbie-ampm"><option>AM</option><option>PM</option></select>
            </div>
            <div className="text-xs text-muted" style={{ marginTop: 4 }}>Format: H:MM (e.g. 10:30 or 9:45)</div>
          </div>
          <div>
            <label className="text-sm font-bold text-muted" style={{ display: 'block', marginBottom: 6 }}>TIMEZONE</label>
            <select value={tz} onChange={e => setTz(e.target.value)} style={{ maxWidth: 200 }} data-testid="newbie-tz">
              <option>EST (Eastern)</option><option>CST (Central)</option><option>MST (Mountain)</option><option>PST (Pacific)</option>
            </select>
          </div>
        </div>
      </div>
      {candidateName && (
        <div className="text-sm text-muted" style={{ marginTop: 12, textAlign: 'center' }}>
          Calendar event: <b>{getCalendarTitle()}</b>
        </div>
      )}
      <div style={{ marginTop: 24, textAlign: 'center' }}>
        <button className="btn btn-primary" onClick={handleGcal} data-testid="newbie-gcal" title="Opens Google Calendar with a pre-filled event">Add to Google Calendar</button>
      </div>

      <TechIssueDialog open={techOpen} onClose={() => setTechOpen(false)} isFinalAttempt={isFinal} onNavigate={onNavigate} />

      <div className="footer-bar" data-testid="newbie-footer">
        <button className="btn btn-muted btn-sm" onClick={async () => {
          if (await modal.confirm('Confirm', 'Discard session and lose all progress?')) { await api.discardSession(); onNavigate('home'); }
        }} data-testid="newbie-discard" title="Discard this session completely">Discard</button>
        <button className="btn btn-danger btn-sm" onClick={async () => { await api.updateSession({ auto_fail_reason: 'Stopped Responding in Chat', final_status: 'Fail' }); onNavigate('review'); }} data-testid="newbie-stopped" title="Candidate stopped responding in Discord">Stopped Responding</button>
        <button className="btn btn-muted btn-sm" onClick={() => setTechOpen(true)} data-testid="newbie-tech" title="Log a technical issue">Tech Issue</button>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={handleContinue} data-testid="newbie-continue" title="Save newbie shift and go to review">Continue to Review</button>
      </div>
    </div>
  );
}
