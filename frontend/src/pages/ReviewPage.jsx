import React, { useState, useEffect } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';

function computeFinalStatus(session) {
  if (!session) return 'Fail';

  const autoFail = session.auto_fail_reason;
  const supOnly = session.supervisor_only || false;
  const callsPassed = [
    (session.call_1 || {}).result,
    (session.call_2 || {}).result,
    (session.call_3 || {}).result,
  ].filter((result) => result === 'Pass').length;
  const supsPassed = [
    (session.sup_transfer_1 || {}).result,
    (session.sup_transfer_2 || {}).result,
  ].filter((result) => result === 'Pass').length;
  const newbie = session.newbie_shift_data;

  let finalStatus = 'Fail';
  if (!autoFail) {
    if (supOnly) {
      if (supsPassed >= 1) finalStatus = 'Pass';
      else if (newbie) finalStatus = 'Incomplete';
    } else if (callsPassed >= 2) {
      if (supsPassed >= 1) finalStatus = 'Pass';
      else if (newbie) finalStatus = 'Incomplete';
    }
  }

  return finalStatus;
}

export default function ReviewPage({ onNavigate }) {
  const modal = useModal();
  const [session, setSession] = useState(null);
  const [coaching, setCoaching] = useState('');
  const [fail, setFail] = useState('');
  const [loading, setLoading] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [filling, setFilling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { session: s } = await api.getCurrentSession();
        if (cancelled) return;
        if (!s || !s.candidate_name) { setSession(null); setLoading(false); return; }
        const finalStatus = s.final_status || computeFinalStatus(s);
        const resolvedSession = { ...s, final_status: finalStatus };
        setSession(resolvedSession);

        if (!s.final_status) {
          await api.updateSession({ final_status: finalStatus });
        }

        // Generate summaries
        const summaries = await api.generateSummaries();
        if (!cancelled) {
          setCoaching(summaries.coaching || '');
          setFail(summaries.fail || '');
        }
      } catch (_err) {
        // Session load or summary generation failed — handled by loading/empty state
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="page-loading" data-testid="review-page">Loading review...</div>;
  if (!session) return <div className="stub-page" data-testid="review-page"><h1>No Active Session</h1><p>Start a session from the Home screen.</p></div>;

  const s = session;
  const autoFail = s.auto_fail_reason;
  const supOnly = s.supervisor_only || false;
  const c1r = (s.call_1 || {}).result;
  const c2r = (s.call_2 || {}).result;
  const c3r = (s.call_3 || {}).result;
  const s1r = (s.sup_transfer_1 || {}).result;
  const s2r = (s.sup_transfer_2 || {}).result;
  const newbie = s.newbie_shift_data;

  const finalStatus = s.final_status || computeFinalStatus(s);
  let bannerClass, bannerText;
  if (finalStatus === 'Pass') { bannerClass = 'banner-pass'; bannerText = 'SESSION PASSED'; }
  else if (finalStatus === 'Incomplete') { bannerClass = 'banner-incomplete'; bannerText = 'SESSION INCOMPLETE — Pending Newbie Shift'; }
  else { bannerClass = 'banner-fail'; bannerText = autoFail ? `AUTO-FAIL: ${autoFail.toUpperCase()}` : 'SESSION FAILED'; }

  const colorResult = (r) => {
    if (r === 'Pass') return <span style={{ color: 'var(--color-success)', fontWeight: 700 }}>PASS</span>;
    if (r === 'Fail') return <span style={{ color: 'var(--color-danger)', fontWeight: 700 }}>FAIL</span>;
    return <span style={{ color: 'var(--text-tertiary)' }}>Did Not Take</span>;
  };

  const copyText = async (text, btnId) => {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById(btnId);
    if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = orig; }, 1500); }
  };

  const handleRegen = async (type) => {
    try {
      const r = await api.regenerateSummary(type);
      if (r.ok) { if (type === 'coaching') setCoaching(r.text); else setFail(r.text); }
      else await modal.error('Regeneration Failed', r.error || 'Unknown error');
    } catch (e) { await modal.error('Error', e.message); }
  };

  const handleFillForm = async () => {
    setFilling(true);
    try {
      const r = await api.fillForm(coaching, fail);
      if (r.ok) await modal.alert('Form Filled', r.message);
      else await modal.error('Form Fill Failed', r.message || 'Error');
    } catch (e) { await modal.error('Error', e.message); }
    setFilling(false);
  };

  const handleFinish = async () => {
    if (!await modal.confirm('Finish Session', 'Save this session and finish?<br><br>This will save to history and clear the current draft.')) return;
    setFinishing(true);
    try {
      const r = await api.finishSession(coaching, fail);
      if (r.ok) { await modal.alert('Session Saved', 'Your session has been saved successfully!'); onNavigate('home'); }
      else { await modal.error('Error', r.error || 'Unknown'); }
    } catch (e) { await modal.error('Error', e.message); }
    setFinishing(false);
  };

  return (
    <div data-testid="review-page">
      <h1 style={{ marginBottom: 24 }}>Session Review & Summary</h1>
      <div className={`banner ${bannerClass}`} data-testid="review-banner">{bannerText}</div>

      <div className="card" style={{ marginTop: 24 }}>
        <div style={{ lineHeight: 1.7 }}>
          <strong style={{ fontSize: '1.125rem', color: 'var(--color-primary)' }}>Candidate: {s.candidate_name}</strong><br /><br />
          <strong>Skills:</strong> {supOnly ? 'Supervisor Transfer ONLY' : 'Mock Calls + Supervisor Transfer'}<br />
          {autoFail && <><strong>Auto-Fail:</strong> <span style={{ color: 'var(--color-danger)' }}>{autoFail}</span><br /></>}
          {!supOnly && (<>
            <br /><strong>— CALL RESULTS —</strong><br />
            <strong>Call 1:</strong> {colorResult(c1r)}<br />
            <strong>Call 2:</strong> {colorResult(c2r)}<br />
            <strong>Call 3:</strong> {colorResult(c3r)}<br />
          </>)}
          <br /><strong>— SUP TRANSFER RESULTS —</strong><br />
          <strong>Transfer 1:</strong> {colorResult(s1r)}<br />
          <strong>Transfer 2:</strong> {colorResult(s2r)}<br />
          {newbie && (<>
            <br /><strong>— NEWBIE SHIFT —</strong><br />
            <strong>Date/Time:</strong> {newbie.newbie_date || ''} at {newbie.newbie_time || ''} {newbie.newbie_tz || ''}<br />
          </>)}
        </div>
      </div>

      <div style={{ marginTop: 32 }}>
        <h3 style={{ marginBottom: 8 }}>Coaching Summary</h3>
        <textarea className="review-textarea" rows={6} value={coaching} onChange={e => setCoaching(e.target.value)} data-testid="review-coaching" />
        <div className="review-btn-row">
          <button className="btn btn-primary btn-sm" id="btn-copy-coaching" onClick={() => copyText(coaching, 'btn-copy-coaching')} data-testid="review-copy-coaching">Copy</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleRegen('coaching')} data-testid="review-regen-coaching">Regenerate</button>
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 8 }}>Fail Summary</h3>
        <textarea className="review-textarea" rows={6} value={fail} onChange={e => setFail(e.target.value)} data-testid="review-fail" />
        <div className="review-btn-row">
          <button className="btn btn-primary btn-sm" id="btn-copy-fail" onClick={() => copyText(fail, 'btn-copy-fail')} data-testid="review-copy-fail">Copy</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleRegen('fail')} data-testid="review-regen-fail">Regenerate</button>
        </div>
      </div>

      <div className="footer-bar" data-testid="review-footer">
        <span className="spacer" />
        <button className="btn btn-warning" onClick={handleFillForm} disabled={filling} data-testid="review-fill-form">{filling ? 'Working...' : 'Fill Form'}</button>
        <button className="btn btn-success btn-lg" onClick={handleFinish} disabled={finishing} data-testid="review-finish">{finishing ? 'Saving...' : 'Save & Finish Session'}</button>
      </div>
    </div>
  );
}
