import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import TechIssueDialog from '../components/TechIssueDialog';
import PhoneticsTableButton from '../components/PhoneticsTableButton';
import WorkflowProgress, { getWorkflowProgress } from '../components/WorkflowProgress';
const DEFAULT_SUP_COACHING = [
  { label: 'Minimize dead air', helper: 'Maintain engagement throughout hold and transfer' },
  { label: 'Queue Not Changed', helper: 'Did not change queue to ACD Direct Supervisor' },
  { label: 'Caller Placed On Hold' },
  { label: 'Verification', children: ['Name', 'Address', 'Phone', 'Email', 'Card/EFT', 'Phonetics for Sound Alike Letters'] },
  { label: 'Discord permission', helper: 'Ask explicit permission to transfer via Discord' },
  { label: 'Did not notify caller of transfer', helper: 'Notify caller before transferring' },
  { label: 'Screenshots/Discord Chat', helper: 'Coached with standard instructions and screenshots' },
  { label: 'Other' },
];

const DEFAULT_SUP_FAILS = [
  'Did not ask permission to transfer', 'Did not minimize dead air', 'Caller Placed On Hold',
  'Transferred to wrong queue', 'Did not inform caller of transfer', 'Other',
];

const DEFAULT_SUP_REASONS = [
  'Hung up on', 'Charged for a cancelled sustaining', 'Double Charged',
  'Damaged Gift', "Didn't Receive Gift", 'Cancel Sustaining', 'Use Own/Other',
];

function cleanScenarioSentence(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim()
    .replace(/[.!?]+$/g, '');
}

function formatScenarioNote(note) {
  const text = cleanScenarioSentence(note);
  if (!text) return '';
  const sentence = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  if (/^(ask|inquire|request|choose|for|please|mention|confirm|verify|use|select|you|i|we|they|he|she)\b/i.test(text)) {
    return `${sentence}.`;
  }
  if (/^(how|which|what|when|where|why|whether|if)\b/i.test(text)) {
    return `You are also wondering ${text}.`;
  }
  return `You are also asking about ${text}.`;
}

function getLastCompletedTransferNum(session) {
  if (session?.sup_transfer_2?.result) return 2;
  return 1;
}

function getLastCompletedCallNum(session) {
  for (let i = 3; i >= 1; i -= 1) {
    if (session?.[`call_${i}`]?.result) return i;
  }
  return 1;
}

function getTransferRecordForNum(session, transferNum) {
  const normalized = Math.max(1, Math.min(2, Number(transferNum) || 1));
  return session?.[`sup_transfer_${normalized}`] || null;
}

function fireAndForgetSessionUpdate(payload) {
  try {
    const pending = api.updateSession(payload);
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => {});
    }
  } catch (_error) {}
}

export default function SupTransferPage({ onNavigate, navigationState }) {
  const modal = useModal();
  const [transferNum, setTransferNum] = useState(1);
  const [result, setResult] = useState(null);
  const [defaults, setDefaults] = useState({});
  const [settings, setSettings] = useState({});
  const [techOpen, setTechOpen] = useState(false);
  const [setup, setSetup] = useState({ caller: '', show: '', reason: '' });
  const [coaching, setCoaching] = useState({});
  const [coachNotes, setCoachNotes] = useState('');
  const [fails, setFails] = useState({});
  const [failNotes, setFailNotes] = useState('');
  const [isFinal, setIsFinal] = useState(false);
  const [isSupervisorOnly, setIsSupervisorOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const [candidateName, setCandidateName] = useState('');
  const hydratedRef = useRef(false);
  const latestDraftPayloadRef = useRef(null);
  const sessionRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ session }, d, s] = await Promise.all([api.getCurrentSession(), api.getDefaults(), api.getSettings()]);
        if (cancelled) return;
        setDefaults(d); setSettings(s);
        const source = d?._content_sources || {};
        console.log('[SAM] Loading shows from Google Sheets...');
        console.log(`[SAM] Active shows source: ${source.shows?.source || 'unknown'}${source.shows?.detail ? ` (${source.shows.detail})` : ''}`);
        console.log(`[SAM] Loaded ${(s.shows || d.shows || []).length} shows`);
        console.log(`[SAM] Loaded ${[
          ...(s.donors_new || d.donors_new || []),
          ...(s.donors_existing || d.donors_existing || []),
          ...(s.donors_increase || d.donors_increase || []),
        ].length} callers`);
        if ((source.shows?.source || '').toLowerCase() !== 'google') {
          console.log('[SAM] Falling back to CSV...');
        }
        const initialSupReasons = s.sup_reasons || d.sup_reasons || DEFAULT_SUP_REASONS;
        sessionRef.current = session || null;
        const requestedTransferNum = Math.max(1, Math.min(2, Number(navigationState?.transferNum) || 0));
        const savedDraft = session?.current_sup_transfer_draft || null;
        const resolvedTransferNum = requestedTransferNum || savedDraft?.transfer_num || (session?.sup_transfer_1?.result ? 2 : 1);
        const normalizedTransferNum = Math.max(1, Math.min(2, resolvedTransferNum || 1));
        const savedTransfer = getTransferRecordForNum(session, normalizedTransferNum);
        const draftMatchesRequestedTransfer = savedDraft && Number(savedDraft.transfer_num || 0) === normalizedTransferNum;
        const draftHasUserState = Boolean(
          savedDraft?.result ||
          Object.values(savedDraft?.coaching || {}).some(Boolean) ||
          Object.values(savedDraft?.fails || {}).some(Boolean) ||
          String(savedDraft?.coach_notes || savedDraft?.fail_notes || '').trim()
        );
        const hydrateSource = draftMatchesRequestedTransfer && (requestedTransferNum || draftHasUserState) ? savedDraft : savedTransfer;
        setSetup({
          caller: hydrateSource?.caller || '',
          show: hydrateSource?.show || '',
          reason: hydrateSource?.reason || initialSupReasons[0] || '',
        });
        if (!cancelled && session) {
          setIsFinal(session.final_attempt || false);
          setIsSupervisorOnly(session.supervisor_only || false);
          setCandidateName(session.candidate_name || '');
          setTransferNum(normalizedTransferNum);
          setResult(hydrateSource?.result || null);
          setCoaching(hydrateSource?.coaching || {});
          setCoachNotes(hydrateSource?.coach_notes || '');
          setFails(hydrateSource?.fails || {});
          setFailNotes(hydrateSource?.fail_notes || '');
          setSupRandFlags(hydrateSource?.rand_flags || {
            phone: ['Mobile', 'Landline'][Math.floor(Math.random() * 2)],
            sms: ['Yes', 'No'][Math.floor(Math.random() * 2)],
            enews: ['Yes', 'No'][Math.floor(Math.random() * 2)],
            ship: ['Yes', 'No'][Math.floor(Math.random() * 2)],
          });
        }
      } catch (err) {
        // Failed to load transfer setup data — page renders with empty dropdowns
      }
      if (!cancelled) hydratedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [navigationState]);

  useLayoutEffect(() => {
    const el = document.querySelector('[data-testid="page-content"]');
    if (el) {
      el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  }, [transferNum]);

  const shows = useMemo(() => settings.shows || defaults.shows || [], [settings.shows, defaults.shows]);
  const supCoaching = settings.sup_coaching || defaults.sup_coaching || DEFAULT_SUP_COACHING;
  const supFails = settings.sup_fails || defaults.sup_fails || DEFAULT_SUP_FAILS;
  const supReasons = settings.sup_reasons || defaults.sup_reasons || DEFAULT_SUP_REASONS;
  const callers = useMemo(() => {
    const allCallers = [
      ...(settings.donors_new || defaults.donors_new || []),
      ...(settings.donors_existing || defaults.donors_existing || []),
      ...(settings.donors_increase || defaults.donors_increase || []),
    ];
    const seen = new Set();
    return allCallers.filter((caller) => {
      const key = `${caller[0] || ''}|${caller[1] || ''}|${caller[6] || ''}|${caller[7] || ''}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [
    settings.donors_new,
    defaults.donors_new,
    settings.donors_existing,
    defaults.donors_existing,
    settings.donors_increase,
    defaults.donors_increase,
  ]);
  useEffect(() => {
    if (!callers.length) return;
    const currentName = setup.caller;
    const isValidCaller = callers.some((caller) => `${caller[0]} ${caller[1]}` === currentName);
    if (!isValidCaller) {
      setSetup((prev) => ({ ...prev, caller: `${callers[0][0]} ${callers[0][1]}` }));
    }
  }, [callers, setup.caller]);
  const callerIdx = Math.max(0, callers.findIndex(c => `${c[0]} ${c[1]}` === setup.caller));
  const currentCaller = useMemo(() => callers[callerIdx] || callers[0] || [], [callers, callerIdx]);
  const showData = useMemo(() => shows.find(s => s[0] === setup.show) || [], [shows, setup.show]);
  const scenarioNotes = useMemo(() => formatScenarioNote(showData?.[4]), [showData]);

  const [supRandFlags, setSupRandFlags] = useState(() => ({
    phone: ['Mobile', 'Landline'][Math.floor(Math.random() * 2)],
    sms: ['Yes', 'No'][Math.floor(Math.random() * 2)],
    enews: ['Yes', 'No'][Math.floor(Math.random() * 2)],
    ship: ['Yes', 'No'][Math.floor(Math.random() * 2)],
  }));

  const regenSupFlags = () => setSupRandFlags({
    phone: ['Mobile', 'Landline'][Math.floor(Math.random() * 2)],
    sms: ['Yes', 'No'][Math.floor(Math.random() * 2)],
    enews: ['Yes', 'No'][Math.floor(Math.random() * 2)],
    ship: ['Yes', 'No'][Math.floor(Math.random() * 2)],
  });

  const buildReasonText = useCallback((reason) => {
    const r = (reason || '').toLowerCase();
    if (r.includes('hung up')) return 'was hung up on';
    if (r.includes('charged') && r.includes('cancelled')) return 'was charged for a cancelled sustaining donation';
    if (r.includes('double')) return 'was double charged';
    if (r.includes('damaged')) return 'received a damaged gift';
    if (r.includes('receive')) return "didn't receive their gift";
    if (r.includes('cancel')) return 'wants to cancel their sustaining donation';
    return reason || '';
  }, []);

  useEffect(() => {
    if (!hydratedRef.current || !candidateName) {
      return undefined;
    }

    const payload = {
      current_sup_transfer_num: transferNum,
      current_sup_transfer_draft: {
        transfer_num: transferNum,
        result,
        caller: setup.caller || (currentCaller.length ? `${currentCaller[0]} ${currentCaller[1]}` : ''),
        show: setup.show || (shows[0]?.[0] || ''),
        reason: setup.reason,
        coaching,
        coach_notes: coachNotes,
        fails,
        fail_notes: failNotes,
        rand_flags: supRandFlags,
      },
    };
    latestDraftPayloadRef.current = payload;

    const timer = window.setTimeout(() => {
      fireAndForgetSessionUpdate(payload);
    }, 250);

    return () => window.clearTimeout(timer);
  }, [transferNum, result, setup, currentCaller, shows, coaching, coachNotes, fails, failNotes, supRandFlags, candidateName]);

  useEffect(() => {
    return () => {
      if (latestDraftPayloadRef.current) {
        fireAndForgetSessionUpdate(latestDraftPayloadRef.current);
      }
    };
  }, []);

  const saveTransferDraftNow = useCallback(async () => {
    const payload = latestDraftPayloadRef.current || {};
    if (latestDraftPayloadRef.current) {
      const response = await api.updateSession(latestDraftPayloadRef.current).catch((error) => ({ ok: false, error }));
      if (response?.ok !== false) return response?.session || { ...(sessionRef.current || {}), ...payload };
    }
    const current = await api.getCurrentSession().catch(() => null);
    if (!current?.session?.candidate_name && candidateName) {
      const fallbackSession = {
        ...(sessionRef.current || {}),
        candidate_name: candidateName,
        tester_name: sessionRef.current?.tester_name || settings.tester_name || '',
        final_attempt: isFinal,
        supervisor_only: isSupervisorOnly,
        status: 'In Progress',
        tech_issue: 'Technical issue unresolved',
        ...payload,
      };
      await api.startSession(fallbackSession);
      return fallbackSession;
    }
    return current?.session || { ...(sessionRef.current || {}), ...payload };
  }, [candidateName, isFinal, isSupervisorOnly, settings.tester_name]);

  const resetTransfer = () => {
    setResult(null);
    setCoaching({});
    setCoachNotes('');
    setFails({});
    setFailNotes('');
  };

  const handleContinue = async () => {
    if (!result) { await modal.warning('Notice', 'Select PASS or FAIL.'); return; }
    if (result === 'Fail' && !Object.values(fails).some(v => v)) { await modal.warning('Notice', 'Select at least one Fail Reason.'); return; }
    const hasCoaching = Object.values(coaching).some(v => v);
    if (!hasCoaching) {
      const cont = await modal.showModal({
        type: 'confirm',
        title: 'No Coaching',
        body: 'You did not select any coaching for this transfer. Continue anyway?',
        graphic: 'question',
        buttons: [
          { label: 'Yes', cls: 'btn-primary', value: true },
          { label: 'No', cls: 'btn-muted', value: false },
        ],
      });
      if (!cont) return;
    }

    const data = {
      transfer_num: transferNum, result,
      caller: setup.caller || (currentCaller.length ? `${currentCaller[0]} ${currentCaller[1]}` : ''),
      show: setup.show || (shows.length ? shows[0][0] : ''), reason: setup.reason,
      coaching, coach_notes: coachNotes, fails, fail_notes: failNotes,
    };
    latestDraftPayloadRef.current = null;
    await api.saveSupTransfer(data);
    await api.updateSession({ current_sup_transfer_draft: null, current_sup_transfer_num: null });

    if (transferNum === 1) {
      if (result === 'Pass') { onNavigate('review'); }
      else {
        setTransferNum(2);
        resetTransfer();
        regenSupFlags();
      }
    } else {
      if (result === 'Fail') {
        const { session } = await api.getCurrentSession();
        if (session && session.final_attempt) { await api.updateSession({ final_status: 'FAIL-Final Attempt' }); onNavigate('review'); }
        else { onNavigate('newbieshift'); }
      } else { onNavigate('review'); }
    }
  };

  const handleStoppedResponding = useCallback(async () => {
    const confirmed = await modal.confirm(
      'Confirm Auto-Fail',
      `This will Automatically fail ${candidateName} and mark as Stopped Responding in Chat. Do you want to proceed?`,
      'alert-triangle',
      'warning'
    );
    if (!confirmed) return;
    latestDraftPayloadRef.current = null;
    await api.updateSession({ auto_fail_reason: 'Stopped Responding in Chat', final_status: 'Fail' });
    onNavigate('review');
  }, [candidateName, modal, onNavigate]);

  const handleSupervisorOnlyAutoFail = useCallback(async (reason) => {
    if (!candidateName.trim()) {
      await modal.warning('Missing Info', 'Enter the Candidate Name first.');
      return;
    }

    let body = '';
    if (reason === 'NC/NS') {
      body = `This will Automatically fail ${candidateName.trim()} and mark as a NC/NS. Do you want to proceed?`;
    } else {
      body = `This will Automatically fail ${candidateName.trim()} and mark as Not Ready for Session. Do you want to proceed?`;
    }

    const confirmed = await modal.confirm('Confirm Auto-Fail', body, 'alert-triangle', 'warning');
    if (!confirmed) return;

    latestDraftPayloadRef.current = null;
    await api.updateSession({
      auto_fail_reason: reason,
      final_status: 'Fail',
      current_sup_transfer_draft: null,
      current_sup_transfer_num: null,
    });
    onNavigate('review');
  }, [candidateName, modal, onNavigate]);

  const handleDiscardSession = useCallback(async () => {
    const confirmed = await modal.confirmDanger('Discard Session', 'Discard the current session draft and lose all progress? This cannot be undone.');
    if (!confirmed) return;
    latestDraftPayloadRef.current = null;
    await api.discardSession();
    onNavigate('home');
  }, [modal, onNavigate]);

  const handleBack = useCallback(async () => {
    await saveTransferDraftNow();
    if (transferNum > 1) {
      onNavigate('suptransfer', { transferNum: 1 });
      return;
    }
    if (isSupervisorOnly) {
      onNavigate('basics');
      return;
    }
    try {
      const { session } = await api.getCurrentSession();
      sessionRef.current = session || sessionRef.current;
    } catch (_error) {
      // Use the last hydrated session if the refresh fails.
    }
    onNavigate('calls', { callNum: getLastCompletedCallNum(sessionRef.current) });
  }, [transferNum, saveTransferDraftNow, isSupervisorOnly, onNavigate]);

  const toggle = (key, setter) => setter(prev => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="page-with-sticky-actions" data-testid="suptransfer-page">
      <WorkflowProgress
        {...getWorkflowProgress({
          page: 'suptransfer',
          supervisorOnly: isSupervisorOnly,
          transferNum,
        })}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 8 }}>
        <h1 style={{ marginBottom: 0 }}>Supervisor Transfer #{transferNum}</h1>
        {candidateName && (
          <div className="candidate-header">
            <span className="candidate-header-label">Candidate:</span> {candidateName}
          </div>
        )}
      </div>
      <div className="card" style={{ textAlign: 'center', marginBottom: 16, padding: 16, background: 'var(--color-primary)', border: 'none' }} data-tour="sup-discord-banner">
        <div style={{ color: 'white', fontWeight: 700, fontSize: '1.125rem' }}>Call Corp WXYZ Test Transfer #: 1-828-630-7006</div>
      </div>
      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px' }}>
        <span><b>Discord Post for Stars:</b> WXYZ: Supervisor Test Call Being Queued</span>
        <button className="btn btn-primary btn-sm" onClick={() => {
          navigator.clipboard.writeText('WXYZ: Supervisor Test Call Being Queued');
          setCopied(true); setTimeout(() => setCopied(false), 3000);
        }} data-testid="sup-copy-discord">{copied ? 'Copied' : 'Copy'}</button>
      </div>

      <div className="split-layout">
        <div className="card setup-card" data-tour="sup-setup">
          <h3 style={{ marginBottom: 16 }}>Call Setup</h3>
          <div className="form-row"><label>Caller</label>
            <select value={setup.caller} onChange={e => setSetup(p => ({ ...p, caller: e.target.value }))} data-testid="sup-caller">
              {callers.map(c => <option key={`${c[0]}${c[1]}`}>{c[0]} {c[1]}</option>)}
            </select>
          </div>
          <div className="form-row"><label>Show</label>
            <select value={setup.show} onChange={e => setSetup(p => ({ ...p, show: e.target.value }))} data-testid="sup-show">
              {shows.map(s => <option key={s[0]}>{s[0]}</option>)}
            </select>
          </div>
          <div className="form-row"><label>Reason</label>
            <select value={setup.reason} onChange={e => setSetup(p => ({ ...p, reason: e.target.value }))} data-testid="sup-reason">
              {supReasons.map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <div className="card card-scenario" data-testid="sup-scenario-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ color: 'var(--border-scenario)', margin: 0 }}>SCENARIO</h3>
            <button className="btn btn-ghost btn-sm" onClick={regenSupFlags} data-testid="sup-regen">{'\uD83D\uDD04'} Regenerate</button>
          </div>
          {currentCaller.length > 0 ? (
            <>
              <p style={{ lineHeight: 1.7, marginBottom: 16 }}>
                <b>For this call you will portray {currentCaller[0]} {currentCaller[1]}.</b> {currentCaller[0]} would like to speak with a supervisor. The caller {buildReasonText(setup.reason)} during a previous call.{scenarioNotes ? ` ${scenarioNotes}` : ''}
              </p>
              <div className="scenario-vars">
                <div className="scenario-var"><span className="scenario-var-label">Phone Type:</span><span className={`scenario-var-value scenario-highlight ${supRandFlags.phone === 'Mobile' ? 'scenario-yes' : 'scenario-no'}`}>{supRandFlags.phone}</span></div>
                {supRandFlags.phone === 'Mobile' && <div className="scenario-var"><span className="scenario-var-label">SMS Opt-In:</span><span className={`scenario-var-value ${supRandFlags.sms === 'Yes' ? 'scenario-yes' : 'scenario-no'}`}>{supRandFlags.sms}</span></div>}
                <div className="scenario-var"><span className="scenario-var-label">E-Newsletter:</span><span className={`scenario-var-value ${supRandFlags.enews === 'Yes' ? 'scenario-yes' : 'scenario-no'}`}>{supRandFlags.enews}</span></div>
                <div className="scenario-var"><span className="scenario-var-label">Cover $6 Shipping:</span><span className={`scenario-var-value ${supRandFlags.ship === 'Yes' ? 'scenario-yes' : 'scenario-no'}`}>{supRandFlags.ship}</span></div>
              </div>
            </>
          ) : <p className="text-muted">Select caller, show, and reason.</p>}
        </div>
      </div>

      {currentCaller.length > 0 && (
        <div className="card" style={{ margin: '16px 0' }}>
          <h3 style={{ marginBottom: 8 }}>Caller Demographics</h3>
          <div style={{ textAlign: 'center' }}>
            <b>{currentCaller[0]} {currentCaller[1]}</b><br />
            {currentCaller[2]}{currentCaller[3] ? `, ${currentCaller[3]}` : ''}, {currentCaller[4]} {currentCaller[5]}<br />
            Phone: {currentCaller[6]} | Email: {currentCaller[7]}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }} data-tour="sup-result">
        <h3>Transfer Result</h3>
        <div className="result-btns">
          <button className={`result-btn ${result === 'Pass' ? 'selected-pass' : ''}`} onClick={() => setResult('Pass')} data-testid="sup-pass">PASS</button>
          <button className={`result-btn ${result === 'Fail' ? 'selected-fail' : ''}`} onClick={() => setResult('Fail')} data-testid="sup-fail">FAIL</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }} data-tour="sup-coaching">
        <div className="coaching-card-header">
          <h3>Coaching Given</h3>
          <PhoneticsTableButton />
        </div>
        <p className="text-muted text-sm" style={{ marginBottom: 16 }}>One or more may be selected</p>
        <div className="coaching-grid">
          <div>{supCoaching.slice(0, 4).map(item => <CoachItem key={item.label} item={item} checked={coaching} onToggle={k => toggle(k, setCoaching)} />)}</div>
          <div>{supCoaching.slice(4).map(item => <CoachItem key={item.label} item={item} checked={coaching} onToggle={k => toggle(k, setCoaching)} />)}</div>
        </div>
        <div style={{ marginTop: 16 }}>
          <label className="text-sm font-bold">Other Coaching Notes</label>
          <textarea
            rows={2}
            value={coachNotes}
            onChange={e => setCoachNotes(e.target.value)}
            disabled={!coaching['Other']}
            placeholder="Select Other above to enter custom coaching notes."
            style={{ marginTop: 4 }}
            data-testid="sup-coach-notes"
          />
        </div>
      </div>

      {result === 'Fail' && (
        <div className="card card-fail" style={{ marginBottom: 16 }}>
          <h3 style={{ color: 'var(--color-danger)' }}>Fail Reasons</h3>
          <div className="coaching-grid">
            <div>{supFails.slice(0, 3).map(item => (
              <label key={item} className="checkbox-label"><input type="checkbox" checked={!!fails[item]} onChange={() => toggle(item, setFails)} /><span>{item}</span></label>
            ))}</div>
            <div>{supFails.slice(3).map(item => (
              <label key={item} className="checkbox-label"><input type="checkbox" checked={!!fails[item]} onChange={() => toggle(item, setFails)} /><span>{item}</span></label>
            ))}</div>
          </div>
          <div style={{ marginTop: 16 }}>
            <label className="text-sm font-bold">Other Fail Notes</label>
            <textarea
              rows={2}
              value={failNotes}
              onChange={e => setFailNotes(e.target.value)}
              disabled={!fails['Other']}
              placeholder="Select Other above to enter custom fail notes."
              style={{ marginTop: 4 }}
              data-testid="sup-fail-notes"
            />
          </div>
        </div>
      )}

      <TechIssueDialog open={techOpen} onClose={() => setTechOpen(false)} isFinalAttempt={isFinal} onNavigate={onNavigate} onBeforeNavigate={saveTransferDraftNow} context="suptransfer" />

      <div className="footer-bar sticky-action-footer" data-testid="sup-footer">
        <div className="action-safety-group">
          <button className="btn btn-muted btn-sm" onClick={handleBack} data-testid="sup-back">Back</button>
          <button className="btn btn-danger-outline btn-sm" onClick={handleDiscardSession} data-testid="sup-discard" title="Discard the current session draft and lose all progress">Discard Session</button>
        </div>
        <span className="action-divider" aria-hidden="true" />
        {isSupervisorOnly && transferNum === 1 && (
          <button className="btn btn-danger btn-sm" onClick={() => handleSupervisorOnlyAutoFail('NC/NS')} data-testid="sup-ncns" title="No Call / No Show — candidate did not join the supervisor transfer session">NC / NS</button>
        )}
        {isSupervisorOnly && transferNum === 1 && (
          <button className="btn btn-danger btn-sm" onClick={() => handleSupervisorOnlyAutoFail('Not Ready for Session')} data-testid="sup-notready" title="Candidate was not prepared for the supervisor transfer session">Not Ready</button>
        )}
        <button className="btn btn-danger btn-sm" onClick={handleStoppedResponding} data-testid="sup-stopped" title="Candidate went silent in Discord during the session">Stopped Responding</button>
        <button className="btn btn-muted btn-sm" onClick={() => setTechOpen(true)} data-testid="sup-tech" title="Log a technical issue">Tech Issue</button>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={handleContinue} data-testid="sup-continue">Continue</button>
      </div>
    </div>
  );
}

function CoachItem({ item, checked, onToggle }) {
  const parentChecked = !!checked[item.label];
  return (
    <div className="coaching-group">
      <label className="checkbox-label"><input type="checkbox" checked={parentChecked} onChange={() => onToggle(item.label)} /><span>{item.label}</span></label>
      {item.helper && <div className="helper-text">{item.helper}</div>}
      {item.children && item.children.map(child => (
        <label key={child} className={`checkbox-label sub-item ${!parentChecked ? 'disabled' : ''}`}>
          <input type="checkbox" disabled={!parentChecked} checked={!!checked[`${item.label}_${child}`]} onChange={() => onToggle(`${item.label}_${child}`)} /><span>{child}</span>
        </label>
      ))}
    </div>
  );
}
