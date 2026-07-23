import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import api, { findDiscordTemplateMessage } from '../api';
import { useModal } from '../components/ModalProvider';
import TechIssueDialog from '../components/TechIssueDialog';
import WorkflowProgress, { getWorkflowProgress } from '../components/WorkflowProgress';
import FailReasonGrid from '../components/FailReasonGrid';
import FinalAttemptBanner from '../components/FinalAttemptBanner';
import { getPaymentOptionsFromSettings } from '../utils/paymentOptions';
import { mergeAndOrderFailReasons } from '../utils/failReasons';
const DEFAULT_SUP_COACHING = [
  { label: 'Minimize dead air', helper: 'Maintain engagement throughout hold and transfer' },
  { label: 'Queue Not Changed', helper: 'Did not change queue to ACD Direct Supervisor' },
  { label: 'Caller Placed On Hold' },
  { label: 'Verification', children: ['Name', 'Address', 'Phone', 'Email', 'Card/EFT'] },
  { label: 'Discord permission', helper: 'Ask explicit permission to transfer via Discord' },
  { label: 'Did not notify caller of transfer', helper: 'Notify caller before transferring' },
  { label: 'Screenshots/Discord Chat', helper: 'Coached with standard instructions and screenshots' },
  { label: 'Search name for every call', helper: "Search the caller's name on every call to avoid duplicate member records." },
  { label: 'Do not volunteer information', helper: 'Do not verify details the member has not provided, such as an email address.' },
  { label: 'Other' },
];

const DEFAULT_SUP_FAILS = [
  'Did not ask permission to transfer', 'Did not minimize dead air', 'Caller Placed On Hold',
  'Transferred to wrong queue', 'Did not inform caller of transfer', 'Other',
];

export const DEFAULT_SUP_REASONS = [
  'Hung up on', 'Charged for a cancelled sustaining', 'Double Charged',
  'Damaged Gift', "Didn't Receive Gift", 'Cancel Sustaining', 'Use Own/Other',
];

export function getSupervisorReasonScenarioText(reason, customReason = '') {
  const label = cleanScenarioSentence(reason);
  const normalized = label.toLowerCase().replace(/[’']/g, "'");

  if (normalized.includes('use own/other')) {
    const suppliedReason = cleanScenarioSentence(customReason);
    return suppliedReason ? `${suppliedReason}.` : 'Tester’s chosen reason.';
  }
  if (normalized.includes('hung up')) return 'The caller was hung up on during a previous call.';
  if (normalized.includes('charged') && normalized.includes('cancel')) {
    return 'The caller was charged for a cancelled sustaining donation.';
  }
  if (normalized.includes('double') && normalized.includes('charged')) return 'The caller was double charged.';
  if (normalized.includes('damaged') && normalized.includes('gift')) return 'The caller received a damaged gift.';
  if (normalized.includes('receive') && normalized.includes('gift')) return 'The caller did not receive their gift.';
  if (normalized.includes('cancel') && normalized.includes('sustaining')) {
    return 'The caller wants to cancel their sustaining donation.';
  }
  if (!label) return 'Tester’s chosen reason.';
  return `The caller would like to discuss the following issue: ${label}.`;
}

function getSupCoachingForDisplay(items = []) {
  const source = Array.isArray(items) && items.length ? items : DEFAULT_SUP_COACHING;
  const ordered = [];
  const otherItems = [];
  const seen = new Set();

  source.forEach((item) => {
    if (!item || !item.label) return;
    const key = String(item.label || '').trim().toLowerCase();
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    const normalized = { ...item };
    if (/phonetics/i.test(key)) {
      return;
    }
    if (Array.isArray(normalized.children)) {
      normalized.children = normalized.children.filter((child) => !/phonetics/i.test(String(child || '')));
    }
    if (key === 'other') {
      otherItems.push(normalized);
    } else {
      ordered.push(normalized);
    }
  });

  return [...ordered, ...otherItems];
}

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

export default function SupTransferPage({ onNavigate, navigationState, settings: initialSettings = {}, defaults: initialDefaults = {}, currentSession: initialCurrentSession = null }) {
  const modal = useModal();
  const [transferNum, setTransferNum] = useState(1);
  const [result, setResult] = useState(null);
  const [defaults] = useState(() => initialDefaults || {});
  const [settings] = useState(() => initialSettings || {});
  const [techOpen, setTechOpen] = useState(false);
  const [setup, setSetup] = useState({ caller: '', show: '', reason: '' });
  const [coaching, setCoaching] = useState({});
  const [coachNotes, setCoachNotes] = useState('');
  const [fails, setFails] = useState({});
  const [failReasonDetails, setFailReasonDetails] = useState({});
  const [expandedFailDetails, setExpandedFailDetails] = useState({});
  const [failNotes, setFailNotes] = useState('');
  const [isFinal, setIsFinal] = useState(false);
  const [isSupervisorOnly, setIsSupervisorOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedDiscordTemplate, setCopiedDiscordTemplate] = useState('');
  const [candidateName, setCandidateName] = useState('');
  const [paymentSelection, setPaymentSelection] = useState({ cardId: 'default', eftId: 'default' });
  const hydratedRef = useRef(false);
  const latestDraftPayloadRef = useRef(null);
  const sessionRef = useRef(null);
  const transferDraftsRef = useRef({});
  const initialCurrentSessionRef = useRef(initialCurrentSession);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cachedSession = navigationState?.session
          ? { session: navigationState.session }
          : initialCurrentSessionRef.current;
        const { session } = cachedSession && Object.prototype.hasOwnProperty.call(cachedSession, 'session')
          ? cachedSession
          : await api.getCurrentSession();
        if (cancelled) return;
        const initialSupReasons = settings.sup_reasons || defaults.sup_reasons || DEFAULT_SUP_REASONS;
        sessionRef.current = session || null;
        transferDraftsRef.current = session?.sup_transfer_drafts || {};
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
          Object.values(savedDraft?.failReasonDetails || savedDraft?.fail_reason_details || {}).some((value) => String(value || '').trim()) ||
          String(savedDraft?.coach_notes || savedDraft?.fail_notes || '').trim()
        );
        const savedTransferDraft = transferDraftsRef.current?.[normalizedTransferNum] || transferDraftsRef.current?.[String(normalizedTransferNum)] || null;
        const hydrateSource = savedTransferDraft || (draftMatchesRequestedTransfer && (requestedTransferNum || draftHasUserState) ? savedDraft : savedTransfer);
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
          const hydratedFailDetails = hydrateSource?.failReasonDetails || hydrateSource?.fail_reason_details || {};
          setFailReasonDetails(hydratedFailDetails);
          setExpandedFailDetails(Object.fromEntries(
            Object.entries(hydratedFailDetails)
              .filter(([, value]) => String(value || '').trim())
              .map(([key]) => [key, true])
          ));
          setFailNotes(hydrateSource?.fail_notes || '');
          setPaymentSelection(hydrateSource?.payment_selection || { cardId: 'default', eftId: 'default' });
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
  }, [navigationState, settings, defaults]);

  useLayoutEffect(() => {
    const el = document.querySelector('[data-testid="page-content"]');
    if (el) {
      el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  }, [transferNum]);

  const shows = useMemo(() => settings.shows || defaults.shows || [], [settings.shows, defaults.shows]);
  const supCoaching = getSupCoachingForDisplay(settings.sup_coaching || defaults.sup_coaching || DEFAULT_SUP_COACHING);
  const supCoachingSplit = Math.ceil(supCoaching.length / 2);
  const supFails = mergeAndOrderFailReasons(settings.sup_fails || defaults.sup_fails || DEFAULT_SUP_FAILS);
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

  useEffect(() => {
    if (!hydratedRef.current || !candidateName) {
      return undefined;
    }

    const draft = {
      transfer_num: transferNum,
      result,
      caller: setup.caller || (currentCaller.length ? `${currentCaller[0]} ${currentCaller[1]}` : ''),
      show: setup.show || (shows[0]?.[0] || ''),
      reason: setup.reason,
      coaching,
      coach_notes: coachNotes,
      fails,
      failReasonDetails,
      fail_notes: failNotes,
      rand_flags: supRandFlags,
      payment_selection: paymentSelection,
    };
    transferDraftsRef.current = { ...transferDraftsRef.current, [transferNum]: draft };
    const payload = {
      current_sup_transfer_num: transferNum,
      current_sup_transfer_draft: draft,
      sup_transfer_drafts: transferDraftsRef.current,
    };
    latestDraftPayloadRef.current = payload;

    const timer = window.setTimeout(() => {
      fireAndForgetSessionUpdate(payload);
    }, 250);

    return () => window.clearTimeout(timer);
  }, [transferNum, result, setup, currentCaller, shows, coaching, coachNotes, fails, failReasonDetails, failNotes, supRandFlags, paymentSelection, candidateName]);

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
    setFailReasonDetails({});
    setExpandedFailDetails({});
    setFailNotes('');
    setPaymentSelection({ cardId: 'default', eftId: 'default' });
  };

  const handleContinue = async () => {
    if (!result) { await modal.warning('Notice', 'Select PASS or FAIL.'); return; }
    if (result === 'Fail' && !Object.values(fails).some(v => v)) { await modal.warning('Notice', 'Select at least one Fail Reason.'); return; }
    if (result === 'Fail' && fails['Other'] && !failNotes.trim()) { await modal.warning('Notice', 'You selected "Other" — please provide notes.'); return; }
    const hasCoaching = Object.values(coaching).some(v => v);
    if (!hasCoaching) {
      const cont = await modal.showModal({
        type: 'confirm',
        title: 'No Coaching',
        body: 'You did not select any coaching for this transfer. Continue anyway?',
        graphic: 'question',
        buttons: [
          { label: 'No', cls: 'btn-muted', value: false },
          { label: 'Yes', cls: 'btn-primary', value: true },
        ],
      });
      if (!cont) return;
    }

    const data = {
      transfer_num: transferNum, result,
      caller: setup.caller || (currentCaller.length ? `${currentCaller[0]} ${currentCaller[1]}` : ''),
      show: setup.show || (shows.length ? shows[0][0] : ''), reason: setup.reason,
      coaching, coach_notes: coachNotes, fails, failReasonDetails, fail_notes: failNotes,
      rand_flags: supRandFlags, payment_selection: paymentSelection,
    };
    latestDraftPayloadRef.current = null;
    await api.saveSupTransfer(data);
    const nextDrafts = { ...transferDraftsRef.current };
    delete nextDrafts[transferNum];
    transferDraftsRef.current = nextDrafts;
    await api.updateSession({ current_sup_transfer_draft: null, current_sup_transfer_num: null, sup_transfer_drafts: nextDrafts });

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
        const attemptResult = await api.getAttemptState().catch(() => null);
        const terminal = attemptResult?.terminal ?? Boolean(session?.final_attempt && !session?.supervisor_retry_required);
        const retryAllowed = attemptResult?.retryAllowed ?? !terminal;
        if (terminal || !retryAllowed) { await api.updateSession({ final_status: 'FAIL-Final Attempt', supervisor_retry_required: false }); onNavigate('review'); }
        else {
          const promptSignature = 'both_sup_transfers_failed';
          const existingPrompt = session?.newbie_shift_prompt || {};
          const alreadyScheduled = Boolean(session?.newbie_shift_data);
          if (alreadyScheduled) {
            await api.updateSession({ final_status: 'Incomplete', fail_summary: 'N/A' });
            onNavigate('review');
            return;
          }
          if (existingPrompt.trigger === promptSignature && existingPrompt.status === 'dismissed') {
            await api.updateSession({ final_status: 'Incomplete', fail_summary: 'N/A' });
            onNavigate('review');
            return;
          }
          const schedule = await modal.showModal({
            type: 'confirm',
            title: 'Schedule Newbie Shift',
            body: 'This certification session requires follow-up before it can be completed.',
            graphic: 'calendar',
            buttons: [
              { label: 'Skip for Now', cls: 'btn-muted', value: false },
              { label: 'Schedule Newbie Shift', cls: 'btn-primary', value: true },
            ],
          });
          await api.updateSession({
            final_status: 'Incomplete',
            fail_summary: 'N/A',
            supervisor_retry_required: true,
            final_attempt: Boolean(attemptResult?.retryIsFinalAttempt || session?.final_attempt),
            attempt_state: attemptResult?.attemptState || session?.attempt_state || null,
            newbie_shift_prompt: {
              trigger: promptSignature,
              status: schedule ? 'accepted' : 'dismissed',
              updated_at: new Date().toISOString(),
            },
          });
          onNavigate(schedule ? 'newbieshift' : 'review');
        }
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

    let resolvedReason = reason;
    let body = '';
    if (reason === 'NC/NS') {
      resolvedReason = 'NC/NS';
      body = `This will automatically fail ${candidateName.trim()} and mark the supervisor transfer as a No Call No Show. Do you want to continue?`;
    } else {
      body = `This will Automatically fail ${candidateName.trim()} and mark as Not Ready for Session. Do you want to proceed?`;
    }

    const confirmed = await modal.showModal({
      type: 'confirm',
      title: reason === 'NC/NS' ? 'Confirm Supervisor Transfer NC/NS' : 'Confirm Auto-Fail',
      body,
      graphic: 'warning',
      buttons: [
        { label: 'Cancel', cls: 'btn-muted', value: false },
        { label: reason === 'NC/NS' ? 'Mark NC/NS' : 'Yes', cls: 'btn-danger', value: true },
      ],
    });
    if (!confirmed) return;

    latestDraftPayloadRef.current = null;
    await api.updateSession({
      auto_fail_reason: resolvedReason,
      final_status: 'Fail',
      current_sup_transfer_draft: null,
      current_sup_transfer_num: null,
    });
    onNavigate('review');
  }, [candidateName, modal, onNavigate]);

  const copyDiscordTemplate = useCallback(async (templateTitle, label) => {
    const message = findDiscordTemplateMessage(settings, defaults, templateTitle);
    if (!String(message || '').trim()) {
      await modal.warning('Discord Post Unavailable', `${label} is not available from Discord posts right now.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(message);
      setCopiedDiscordTemplate(templateTitle);
      window.setTimeout(() => {
        setCopiedDiscordTemplate((current) => (current === templateTitle ? '' : current));
      }, 3000);
    } catch (_error) {
      await modal.warning('Copy Failed', 'Unable to copy this Discord post automatically. Please open Discord Post and copy it manually.');
    }
  }, [defaults, modal, settings]);

  const handleDiscardSession = useCallback(async () => {
    const confirmed = await modal.confirmDanger('Discard Session', 'Discard the current session draft and lose all progress? This cannot be undone.');
    if (!confirmed) return;
    latestDraftPayloadRef.current = null;
    await api.discardSession();
    onNavigate('home');
  }, [modal, onNavigate]);

  const handleBack = useCallback(async () => {
    await saveTransferDraftNow();
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
  }, [saveTransferDraftNow, isSupervisorOnly, onNavigate]);

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
      {isSupervisorOnly && (
        <div className="banner banner-incomplete" style={{ fontSize: 'var(--font-size-sm)', marginBottom: 12 }} data-testid="sup-only-mode-banner">
          Supervisor Transfer Only mode
        </div>
      )}
      <FinalAttemptBanner visible={isFinal} attemptState={sessionRef.current?.attempt_state} />
      <div className="card" style={{ textAlign: 'center', marginBottom: 16, padding: 16, background: 'var(--color-primary)', border: 'none' }} data-tour="sup-discord-banner">
        <div style={{ color: 'white', fontWeight: 700, fontSize: '1.125rem' }}>Call Corp WXYZ Test Transfer #: 1-828-630-7006</div>
      </div>
      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 24px' }}>
        <span><b>Discord Post for Stars:</b> WXYZ Supervisor Test Call Being Queued</span>
        <button className="btn btn-primary btn-sm" onClick={() => {
          navigator.clipboard.writeText('WXYZ Supervisor Test Call Being Queued');
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
            <button className="scenario-regen-btn" onClick={regenSupFlags} data-testid="sup-regen" title="Re-roll random variables"><span className="regen-icon">{'\uD83D\uDD04'}</span> Regenerate</button>
          </div>
          {currentCaller.length > 0 ? (
            <>
              <p style={{ lineHeight: 1.7, marginBottom: 16 }}>
                <b>For this call you will portray {currentCaller[0]} {currentCaller[1]}.</b> {currentCaller[0]} would like to speak with a supervisor. {getSupervisorReasonScenarioText(setup.reason)}{scenarioNotes ? ` ${scenarioNotes}` : ''}
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

      <PaymentSimulation
        payment={settings.payment || defaults.payment || {}}
        selection={paymentSelection}
        onSelectionChange={setPaymentSelection}
      />

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
        </div>
        <p className="text-muted text-sm" style={{ marginBottom: 16 }}>One or more may be selected</p>
        <div className="coaching-grid">
          <div>{supCoaching.slice(0, supCoachingSplit).map(item => <CoachItem key={item.label} item={item} checked={coaching} onToggle={k => toggle(k, setCoaching)} />)}</div>
          <div>{supCoaching.slice(supCoachingSplit).map(item => <CoachItem key={item.label} item={item} checked={coaching} onToggle={k => toggle(k, setCoaching)} />)}</div>
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
          <div className="fail-card-header">
            <h3 style={{ color: 'var(--color-danger)' }}>Fail Reasons</h3>
            {transferNum === 1 && (
              <div className="inline-discord-copy">
                <span>Copy Failed 1st Sup Transfer Discord post</span>
                <button
                  type="button"
                  className={`discord-copy ${copiedDiscordTemplate === 'Failed 1st Sup Transfer' ? 'copied' : ''}`}
                  onClick={() => copyDiscordTemplate('Failed 1st Sup Transfer', 'Copy Failed 1st Sup Transfer Discord post')}
                  data-testid="sup-fail-discord-copy"
                >
                  {copiedDiscordTemplate === 'Failed 1st Sup Transfer' ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
          </div>
          <FailReasonGrid
            items={supFails}
            checked={fails}
            onCheckedChange={setFails}
            details={failReasonDetails}
            onDetailsChange={setFailReasonDetails}
            expanded={expandedFailDetails}
            onExpandedChange={setExpandedFailDetails}
          />
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

function PaymentSimulation({ payment, selection, onSelectionChange }) {
  const options = useMemo(() => getPaymentOptionsFromSettings(payment), [payment]);
  const cardId = selection?.cardId || 'default';
  const eftId = selection?.eftId || 'default';
  const selectedCard = options.card.find((item) => item.id === cardId) || options.card[0];
  const selectedEft = options.eft.find((item) => item.id === eftId) || options.eft[0];

  return (
    <div className="card" style={{ marginBottom: 16 }} data-tour="sup-payment">
      <h3 style={{ marginBottom: 8 }}>Payment Simulation</h3>
      <p className="text-muted text-sm payment-training-note">Simulated/training payment info only.</p>
      <div className="payment-grid">
        <div className="payment-card payment-card-cc">
          <div className="payment-card-top">
            <div style={{ fontWeight: 700, fontSize: 12 }}>{selectedCard.type.toUpperCase()}</div>
            <label className="payment-option-select">
              <span>Card Option</span>
              <select value={cardId} onChange={(event) => onSelectionChange((current) => ({ ...current, cardId: event.target.value }))} data-testid="sup-card-option">
                {options.card.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <div className="font-mono font-bold payment-card-number">{selectedCard.number}</div>
          <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>EXP: {selectedCard.exp} &nbsp; CVV: {selectedCard.cvv}</div>
        </div>
        <div className="payment-card payment-card-eft">
          <div className="payment-card-top">
            <div style={{ fontWeight: 700, fontSize: 12 }}>EFT / BANK DRAFT</div>
            <label className="payment-option-select">
              <span>EFT Option</span>
              <select value={eftId} onChange={(event) => onSelectionChange((current) => ({ ...current, eftId: event.target.value }))} data-testid="sup-eft-option">
                {options.eft.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <div className="font-mono font-bold payment-bank-number">RTN: {selectedEft.routing}</div>
          <div className="font-mono font-bold payment-bank-number">ACC: {selectedEft.account}</div>
        </div>
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
