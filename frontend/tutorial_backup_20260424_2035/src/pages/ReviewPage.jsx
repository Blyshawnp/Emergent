import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import WorkflowProgress, { getWorkflowProgress } from '../components/WorkflowProgress';
import geminiActiveGraphic from '../assets/images/Gemini2.png';

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

function normalizeReviewSession(session) {
  if (!session) return null;
  return {
    ...session,
    candidate_name: session.candidate_name || session.candidate || '',
  };
}

function getHistoricalCoachingSummary(session) {
  return (session?.coaching_summary || '').trim() || 'No saved coaching summary is available for this historical record.';
}

function getHistoricalFailSummary(session) {
  const saved = (session?.fail_summary || '').trim();
  if (saved) return saved;
  const finalStatus = session?.final_status || computeFinalStatus(session);
  if (finalStatus === 'Pass' || finalStatus === 'Incomplete') return 'N/A';
  return 'No saved fail summary is available for this historical record.';
}

function getReviewBackTarget(session, isHistoricalReview) {
  if (isHistoricalReview) return 'history';
  if (!session) return 'home';
  if (session.newbie_shift_data) return 'newbieshift';

  const hasSupTransferData = [session.sup_transfer_1, session.sup_transfer_2].some(
    (transfer) => transfer && transfer.result
  );
  if (session.supervisor_only || hasSupTransferData) return 'suptransfer';

  const hasCallData = [session.call_1, session.call_2, session.call_3].some(
    (call) => call && call.result
  );
  if (hasCallData) return 'calls';

  return 'basics';
}

export default function ReviewPage({ onNavigate, navigationState }) {
  const modal = useModal();
  const modalRef = useRef(modal);
  const [session, setSession] = useState(null);
  const [settings, setSettings] = useState({});
  const [coaching, setCoaching] = useState('');
  const [fail, setFail] = useState('');
  const [loading, setLoading] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [filling, setFilling] = useState(false);
  const [hasFilledForm, setHasFilledForm] = useState(false);
  const historyRecord = navigationState?.historyRecord || null;
  const isHistoricalReview = Boolean(historyRecord);

  useEffect(() => {
    modalRef.current = modal;
  }, [modal]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (historyRecord) {
          const resolvedHistorySession = normalizeReviewSession(historyRecord);
          if (cancelled) return;
          setSession(resolvedHistorySession);
          setCoaching(getHistoricalCoachingSummary(resolvedHistorySession));
          setFail(getHistoricalFailSummary(resolvedHistorySession));
          setLoading(false);
          return;
        }

        const [{ session: s }, currentSettings] = await Promise.all([
          api.getCurrentSession(),
          api.getSettings(),
        ]);
        if (cancelled) return;
        if (!s || !s.candidate_name) { setSession(null); setLoading(false); return; }
        setSettings(currentSettings || {});
        const finalStatus = s.final_status || computeFinalStatus(s);
        const resolvedSession = normalizeReviewSession({ ...s, final_status: finalStatus });
        setSession(resolvedSession);

        if (!s.final_status) {
          await api.updateSession({ final_status: finalStatus });
        }

        // Generate summaries
        const summaries = await api.generateSummaries(
          currentSettings?.enable_gemini ? (currentSettings?.gemini_key || '') : ''
        );
        if (!cancelled) {
          setCoaching(summaries.coaching || '');
          setFail(summaries.fail || '');
          if (summaries.error) {
            await modalRef.current.alert('Gemini Notice', summaries.error, 'info', 'popup');
          }
        }
      } catch (err) {
        if (!cancelled) {
          await modalRef.current.error('Summary Generation Failed', err.message || 'Unable to generate summaries.');
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [historyRecord]);

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
    if (isHistoricalReview) return;
    try {
      const r = await api.regenerateSummary(
        type,
        settings?.enable_gemini ? (settings?.gemini_key || '') : ''
      );
      if (r.ok) {
        if (type === 'coaching') setCoaching(r.text);
        else setFail(r.text);

        if (r.error) {
          await modal.alert('Gemini Notice', r.error, 'info', 'popup');
        }
      } else {
        await modal.error('Regeneration Failed', r.error || 'Unknown error');
      }
    } catch (e) { await modal.error('Error', e.message); }
  };

  const runFillForm = async ({ showSuccess = true } = {}) => {
    setFilling(true);
    try {
      const r = await api.fillForm(coaching, fail, isHistoricalReview ? session : null);
      if (r.ok) {
        setHasFilledForm(true);
        if (showSuccess) {
          await modal.alert('Form Filled', r.message, 'check-circle', 'success');
        }
        return true;
      }
      await modal.error('Form Fill Failed', r.message || 'Error');
    } catch (e) { await modal.error('Error', e.message); }
    finally {
      setFilling(false);
    }
    return false;
  };

  const handleFillForm = async () => {
    await runFillForm();
  };

  const handleFinish = async () => {
    if (isHistoricalReview) {
      onNavigate('history');
      return;
    }

    if (!hasFilledForm) {
      const fillChoice = await modal.showModal({
        type: 'confirm',
        title: 'Fill Certification Form',
        body: 'Would you like to fill the certification form before closing this session?',
        graphic: 'form',
        buttons: [
          { label: 'Fill Form', cls: 'btn-warning', value: 'fill' },
          { label: 'No', cls: 'btn-primary', value: 'skip' },
        ],
      });

      if (fillChoice === 'fill') {
        const filled = await runFillForm();
        if (!filled) return;
      } else if (fillChoice !== 'skip') {
        return;
      }
    }

    const confirmed = await modal.showModal({
      type: 'confirm',
      title: 'Finish Session',
      body: 'Save this session and finish?<br><br>This will save to history and clear the current draft.',
      graphic: 'save',
      buttons: [
        { label: 'Yes', cls: 'btn-primary', value: true },
        { label: 'No', cls: 'btn-muted', value: false },
      ],
    });
    if (!confirmed) return;
    setFinishing(true);
    try {
      const r = await api.finishSession(coaching, fail);
      if (r.ok) {
        await modal.showModal({
          type: 'alert',
          title: 'Session Saved',
          body: r.message || 'Your session has been saved successfully!',
          graphic: 'save',
          sound: 'success',
          buttons: [{ label: 'OK', cls: 'btn-primary', value: true }],
        });
        onNavigate('home');
      }
      else { await modal.error('Error', r.error || 'Unknown'); }
    } catch (e) { await modal.error('Error', e.message); }
    setFinishing(false);
  };

  const handleBack = () => {
    onNavigate(getReviewBackTarget(session, isHistoricalReview));
  };

  const geminiActive = Boolean(settings?.enable_gemini && String(settings?.gemini_key || '').trim());

  return (
    <div data-testid="review-page">
      {!isHistoricalReview && (
        <WorkflowProgress
          {...getWorkflowProgress({
            page: 'review',
            supervisorOnly: supOnly,
          })}
        />
      )}
      <h1 style={{ marginBottom: 24 }}>{isHistoricalReview ? 'Historical Review & Summary' : 'Session Review & Summary'}</h1>
      {isHistoricalReview && (
        <div className="card" style={{ marginBottom: 16, background: 'var(--bg-card-hover)' }}>
          <div className="text-muted text-sm">
            Viewing a saved history record in read-only mode. This does not affect the current active session.
          </div>
        </div>
      )}
      <div className={`banner ${bannerClass}`} data-testid="review-banner">{bannerText}</div>

      <div className="card" style={{ marginTop: 24 }}>
        <div style={{ lineHeight: 1.7 }}>
          <div className="candidate-header review-candidate-header">
            <span className="candidate-header-label">Candidate:</span> {s.candidate_name}
          </div><br />
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
        <div className="review-summary-heading">
          <h3>Coaching Summary</h3>
          {geminiActive && (
            <span className="gemini-summary-badge">
              <img src={geminiActiveGraphic} alt="Gemini enabled" />
              Gemini enabled
            </span>
          )}
        </div>
        <textarea className="review-textarea" rows={6} value={coaching} onChange={e => setCoaching(e.target.value)} data-testid="review-coaching" readOnly={isHistoricalReview} />
        <div className="review-btn-row">
          <button className="btn btn-primary btn-sm" id="btn-copy-coaching" onClick={() => copyText(coaching, 'btn-copy-coaching')} data-testid="review-copy-coaching">Copy</button>
          {!isHistoricalReview && <button className="btn btn-ghost btn-sm" onClick={() => handleRegen('coaching')} data-testid="review-regen-coaching">Regenerate</button>}
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <div className="review-summary-heading">
          <h3>Fail Summary</h3>
          {geminiActive && (
            <span className="gemini-summary-badge">
              <img src={geminiActiveGraphic} alt="Gemini enabled" />
              Gemini enabled
            </span>
          )}
        </div>
        <textarea className="review-textarea" rows={6} value={fail} onChange={e => setFail(e.target.value)} data-testid="review-fail" readOnly={isHistoricalReview} />
        <div className="review-btn-row">
          <button className="btn btn-primary btn-sm" id="btn-copy-fail" onClick={() => copyText(fail, 'btn-copy-fail')} data-testid="review-copy-fail">Copy</button>
          {!isHistoricalReview && <button className="btn btn-ghost btn-sm" onClick={() => handleRegen('fail')} data-testid="review-regen-fail">Regenerate</button>}
        </div>
      </div>

      <div className="footer-bar" data-testid="review-footer">
        <button className="btn btn-muted btn-lg" onClick={handleBack} data-testid="review-back">
          {isHistoricalReview ? 'Back to History' : 'Back'}
        </button>
        <span className="spacer" />
        {isHistoricalReview ? (
          <>
            <button className="btn btn-warning btn-lg" onClick={handleFillForm} disabled={filling} data-testid="review-historical-fill-form">{filling ? 'Working...' : 'Fill Form'}</button>
            <button className="btn btn-primary btn-lg" onClick={() => onNavigate('history')} data-testid="review-close-history">Close History Review</button>
          </>
        ) : (
          <>
            <button className="btn btn-warning btn-lg" onClick={handleFillForm} disabled={filling} data-testid="review-fill-form">{filling ? 'Working...' : 'Fill Form'}</button>
            <button className="btn btn-success btn-lg" onClick={handleFinish} disabled={finishing} data-testid="review-finish">{finishing ? 'Saving...' : 'Save & Finish Session'}</button>
          </>
        )}
      </div>
    </div>
  );
}
