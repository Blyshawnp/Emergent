import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import WorkflowProgress, { getWorkflowProgress } from '../components/WorkflowProgress';
import geminiActiveGraphic from '../assets/images/Gemini2.png';
import { buildBasicsFromRecord, mergeBasicsIntoSession } from '../utils/sessionBasics';

function computeFinalStatus(session) {
  if (!session) return 'Fail';

  const autoFail = session.auto_fail_reason;
  const supOnly = session.supervisor_only || false;
  const resumedSup = Boolean(session.resumed_sup_transfer_only || session.resume_source_history_id || session.resume_source_timestamp_iso);
  const finalAttempt = Boolean(session.final_attempt);
  const callsPassed = [
    (session.call_1 || {}).result,
    (session.call_2 || {}).result,
    (session.call_3 || {}).result,
  ].filter((result) => result === 'Pass').length;
  const callsFailed = [
    (session.call_1 || {}).result,
    (session.call_2 || {}).result,
    (session.call_3 || {}).result,
  ].filter((result) => result === 'Fail').length;
  const supsPassed = [
    (session.sup_transfer_1 || {}).result,
    (session.sup_transfer_2 || {}).result,
  ].filter((result) => result === 'Pass').length;
  const supsFailed = [
    (session.sup_transfer_1 || {}).result,
    (session.sup_transfer_2 || {}).result,
  ].filter((result) => result === 'Fail').length;
  const newbie = session.newbie_shift_data;

  if (autoFail) {
    const autoFailText = String(autoFail || '').trim().toLowerCase();
    if (autoFailText.startsWith('nc')) return 'NC/NS';
    return finalAttempt ? 'FAIL-Final Attempt' : 'Fail';
  }

  if (supOnly) {
    if (supsPassed >= 1) return resumedSup ? 'RESUMED-PASS' : 'Pass';
    if (supsFailed >= 2) return finalAttempt ? 'FAIL-Final Attempt' : 'Incomplete';
    return newbie ? 'Incomplete' : 'Incomplete';
  }

  if (callsPassed >= 2) {
    if (supsPassed >= 1) return 'Pass';
    if (supsFailed >= 2) return finalAttempt ? 'FAIL-Final Attempt' : 'Incomplete';
    return newbie ? 'Incomplete' : 'Incomplete';
  }

  if (callsFailed >= 2) return finalAttempt ? 'FAIL-Final Attempt' : 'Fail';
  return 'Incomplete';
}

function normalizeReviewSession(session) {
  if (!session) return null;
  const withResult = (existing, result) => existing || (result ? { result } : existing);
  return {
    ...session,
    candidate_name: session.candidate_name || session.candidate || '',
    tester_name: session.tester_name || '',
    call_1: withResult(session.call_1, session.call_1_result),
    call_2: withResult(session.call_2, session.call_2_result),
    call_3: withResult(session.call_3, session.call_3_result),
    sup_transfer_1: withResult(session.sup_transfer_1, session.sup_transfer_1_result),
    sup_transfer_2: withResult(session.sup_transfer_2, session.sup_transfer_2_result),
    review_notes: session.review_notes || session.notes || '',
  };
}

function reviewSessionDate(session) {
  return session?.timestamp || session?.completed_at || session?.created_at || session?.displayDate || '';
}

function getHistoricalCoachingSummary(session) {
  return (session?.coaching_summary || '').trim() || 'No saved coaching summary is available for this historical record.';
}

function getHistoricalFailSummary(session) {
  const saved = (session?.fail_summary || '').trim();
  if (saved) return saved;
  const finalStatus = session?.final_status || computeFinalStatus(session);
  if (['Pass', 'RESUMED-PASS', 'Incomplete'].includes(finalStatus)) return 'N/A';
  return 'No saved fail summary is available for this historical record.';
}

function getReviewBackTarget(session, isHistoricalReview) {
  if (isHistoricalReview) return { page: 'history' };
  if (!session) return { page: 'home' };
  if (session.newbie_shift_data) return { page: 'newbieshift' };

  if (session.sup_transfer_2?.result) return { page: 'suptransfer', state: { transferNum: 2 } };
  if (session.sup_transfer_1?.result || session.supervisor_only) return { page: 'suptransfer', state: { transferNum: 1 } };

  for (let i = 3; i >= 1; i -= 1) {
    if (session[`call_${i}`]?.result) return { page: 'calls', state: { callNum: i } };
  }

  return { page: 'basics' };
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
  const [regenerating, setRegenerating] = useState('');
  const [hasFilledForm, setHasFilledForm] = useState(false);
  const [summaryDiagnostics, setSummaryDiagnostics] = useState(null);
  const reviewHydratedRef = useRef(false);
  const historyRecord = navigationState?.historyRecord || null;
  const reviewSessionPayload = navigationState?.reviewSession || navigationState?.session || null;
  const isHistoricalReview = Boolean(historyRecord);

  useEffect(() => {
    modalRef.current = modal;
  }, [modal]);

  useEffect(() => {
    let cancelled = false;
    reviewHydratedRef.current = false;
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
        if ((!s || !s.candidate_name) && reviewSessionPayload?.candidate_name) {
          const restored = normalizeReviewSession(mergeBasicsIntoSession(reviewSessionPayload, buildBasicsFromRecord(reviewSessionPayload)));
          await api.startSession(restored).catch(() => {});
          setSettings(currentSettings || {});
          setSession({ ...restored, final_status: computeFinalStatus(restored) });
          setCoaching((restored.coaching_summary || '').trim());
          setFail((restored.fail_summary || '').trim());
          setLoading(false);
          reviewHydratedRef.current = true;
          return;
        }
        if (!s || !s.candidate_name) { setSession(null); setLoading(false); return; }
        setSettings(currentSettings || {});
        const finalStatus = computeFinalStatus(s);
        const resolvedSession = normalizeReviewSession(mergeBasicsIntoSession({ ...s, final_status: finalStatus }, buildBasicsFromRecord(s)));
        setSession(resolvedSession);

        if (!s.final_status) {
          await api.updateSession({ final_status: finalStatus });
        }

        const savedCoaching = (s.coaching_summary || '').trim();
        const savedFail = (s.fail_summary || '').trim();
        if (savedCoaching || savedFail) {
          setCoaching(savedCoaching);
          setFail(savedFail || (['Pass', 'RESUMED-PASS', 'Incomplete'].includes(finalStatus) ? 'N/A' : ''));
          setLoading(false);
          reviewHydratedRef.current = true;
          return;
        }

        // Generate summaries
        const summaries = await api.generateSummaries();
        if (!cancelled) {
          setCoaching(summaries.coaching || '');
          setFail(summaries.fail || '');
          setSummaryDiagnostics(summaries);
          reviewHydratedRef.current = true;
        }
      } catch (err) {
        if (!cancelled) {
          await modalRef.current.error('Summary Generation Failed', err.message || 'Unable to generate summaries.');
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [historyRecord, reviewSessionPayload]);

  useEffect(() => {
    if (isHistoricalReview || !reviewHydratedRef.current || !session?.candidate_name) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      api.updateSession({ coaching_summary: coaching, fail_summary: fail }).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [coaching, fail, isHistoricalReview, session?.candidate_name]);

  if (loading) return <div className="page-loading" data-testid="review-page">{historyRecord ? 'Loading review...' : 'Generating review summaries...'}</div>;
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

  const finalStatus = computeFinalStatus(s);
  let bannerClass, bannerText;
  if (finalStatus === 'Pass' || finalStatus === 'RESUMED-PASS') { bannerClass = 'banner-pass'; bannerText = finalStatus === 'RESUMED-PASS' ? 'RESUMED SESSION PASSED' : 'SESSION PASSED'; }
  else if (finalStatus === 'Incomplete') { bannerClass = 'banner-incomplete'; bannerText = 'SESSION INCOMPLETE — Pending Newbie Shift'; }
  else { bannerClass = 'banner-fail'; bannerText = finalStatus === 'FAIL-Final Attempt' ? 'SESSION FAILED — FINAL ATTEMPT' : autoFail ? `AUTO-FAIL: ${autoFail.toUpperCase()}` : 'SESSION FAILED'; }

  const colorResult = (r) => {
    if (r === 'Pass') return <span style={{ color: 'var(--color-success)', fontWeight: 700 }}>PASS</span>;
    if (r === 'Fail') return <span style={{ color: 'var(--color-danger)', fontWeight: 700 }}>FAIL</span>;
    return <span style={{ color: 'var(--text-tertiary)' }}>Did Not Take</span>;
  };

  const copyText = async (text, btnId) => {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById(btnId);
    if (btn) { const orig = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = orig; }, 3000); }
  };

  const handleRegen = async (type) => {
    if (isHistoricalReview) return;
    if (regenerating) return;
    setRegenerating(type);
    try {
      const r = await api.regenerateSummary(type);
      setSummaryDiagnostics(r);
      if (r.ok) {
        if (type === 'coaching') setCoaching(r.text);
        else setFail(r.text);

      } else {
        if (r.text) {
          if (type === 'coaching') setCoaching(r.text);
          else setFail(r.text);
        } else {
          await modal.error('Regeneration Failed', r.error || 'Unknown error');
        }
      }
    } catch (e) { await modal.error('Error', e.message); }
    finally { setRegenerating(''); }
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

  const handleBack = async () => {
    if (!isHistoricalReview && session?.candidate_name) {
      await api.updateSession({ coaching_summary: coaching, fail_summary: fail }).catch(() => {});
    }
    const target = getReviewBackTarget(session, isHistoricalReview);
    onNavigate(target.page, target.state);
  };

  const handleDiscardSession = async () => {
    const confirmed = await modal.confirmDanger(
      'Discard Session',
      'Discard the current session draft and lose all progress? This cannot be undone.'
    );
    if (!confirmed) return;
    try {
      await api.discardSession();
    } catch (e) {
      // Surface the error but still navigate home so the user is not stuck.
      await modal.error('Discard Failed', e.message || 'Unknown error');
    }
    onNavigate('home');
  };

  const geminiActive = Boolean(settings?.enable_gemini && (settings?.gemini_api_key_configured || String(settings?.gemini_api_key || '').trim()));
  const summaryStatus = (() => {
    if (isHistoricalReview || !summaryDiagnostics) return '';
    if (summaryDiagnostics.gemini_error) return `Gemini unavailable: ${summaryDiagnostics.gemini_error}`;
    if (summaryDiagnostics.used_gemini) return 'Gemini summaries generated';
    if (summaryDiagnostics.used_fallback) return 'Using fallback summaries';
    return '';
  })();

  return (
    <div className="page-with-sticky-actions" data-testid="review-page">
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
          <strong>Tester:</strong> {s.tester_name || 'N/A'}<br />
          <strong>Date:</strong> {reviewSessionDate(s) || 'N/A'}<br />
          <strong>Status:</strong> {s.status || s.final_status || finalStatus}<br />
          <strong>Final Attempt:</strong> {s.final_attempt ? 'Yes' : 'No'}<br />
          <strong>Headset USB:</strong> {s.headset_usb === true ? 'Yes' : s.headset_usb === false ? 'No' : 'N/A'}<br />
          <strong>Noise Cancelling Mic:</strong> {s.noise_cancel === true ? 'Yes' : s.noise_cancel === false ? 'No' : 'N/A'}<br />
          <strong>Headset:</strong> {s.headset_brand || 'N/A'}<br />
          <strong>VPN:</strong> {s.vpn_on === true ? 'Yes' : s.vpn_on === false ? 'No' : 'N/A'}<br />
          {s.vpn_on === true && <><strong>VPN Can Turn Off:</strong> {s.vpn_off === true ? 'Yes' : s.vpn_off === false ? 'No' : 'N/A'}<br /></>}
          <strong>Default Browser:</strong> {s.chrome_default === true ? 'Yes' : s.chrome_default === false ? 'No' : 'N/A'}<br />
          <strong>Extensions Off:</strong> {s.extensions_disabled === true ? 'Yes' : s.extensions_disabled === false ? 'No' : 'N/A'}<br />
          <strong>Pop-ups Allowed:</strong> {s.popups_allowed === true ? 'Yes' : s.popups_allowed === false ? 'No' : 'N/A'}<br />
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
        {summaryStatus && (
          <div className="gemini-summary-status" data-testid="review-gemini-status">
            {summaryStatus}
          </div>
        )}
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
        <div className="review-btn-row" data-tour="review-coaching-actions">
          <button className="btn btn-primary btn-sm" id="btn-copy-coaching" onClick={() => copyText(coaching, 'btn-copy-coaching')} data-testid="review-copy-coaching">Copy</button>
          {!isHistoricalReview && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => handleRegen('coaching')}
              disabled={Boolean(regenerating)}
              data-testid="review-regen-coaching"
            >
              {regenerating === 'coaching' ? 'Regenerating...' : 'Regenerate'}
            </button>
          )}
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
        <div className="review-btn-row" data-tour="review-fail-actions">
          <button className="btn btn-primary btn-sm" id="btn-copy-fail" onClick={() => copyText(fail, 'btn-copy-fail')} data-testid="review-copy-fail">Copy</button>
          {!isHistoricalReview && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => handleRegen('fail')}
              disabled={Boolean(regenerating)}
              data-testid="review-regen-fail"
            >
              {regenerating === 'fail' ? 'Regenerating...' : 'Regenerate'}
            </button>
          )}
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <h3>Notes</h3>
        <textarea className="review-textarea" rows={4} value={s.review_notes || s.notes || ''} readOnly data-testid="review-notes" />
      </div>

      <div className="footer-bar sticky-action-footer" data-testid="review-footer">
        <button className="btn btn-muted btn-lg" onClick={handleBack} data-testid="review-back">
          {isHistoricalReview ? 'Back to History' : 'Back'}
        </button>
        {!isHistoricalReview && (
          <>
            <button className="btn btn-danger-outline btn-sm" onClick={handleDiscardSession} data-testid="review-discard" title="Discard the current session draft and lose all progress">Discard Session</button>
            <span className="action-divider" aria-hidden="true" />
          </>
        )}
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
