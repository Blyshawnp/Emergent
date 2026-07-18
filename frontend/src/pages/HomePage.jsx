import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Rocket, Repeat, History as HistoryIcon, Settings as SettingsIcon, HelpCircle, Activity, Clock3, BarChart3 } from 'lucide-react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import { playSound } from '../utils/sound';
import { buildBasicsFromRecord, findBestBasicsRecord, mergeBasicsIntoSession, sessionDateOf, sessionIdOf } from '../utils/sessionBasics';
import {
  formFillStatusMeta,
  formatNewbieSchedule,
  newbieShiftStatusMeta,
  sessionStatusMeta,
} from '../utils/certificationWorkflow';

const SUP_ONLY_MODE_KEY = 'mts_sup_transfer_only_mode';

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasSavedCallResult(call) {
  return Boolean(call && call.result);
}

function hasSavedSupTransferResult(transfer) {
  return Boolean(transfer && transfer.result);
}

function canResumeForSupTransfer(entry, testerNames) {
  const status = entry.status || entry.final_status || '';
  const storedTesterName = normalizeName(entry.tester_name);
  const matchesTester = testerNames.some((name) => storedTesterName && storedTesterName === normalizeName(name));
  const hasMockCalls = [entry.call_1, entry.call_2, entry.call_3].some(hasSavedCallResult);
  const hasPassedSupTransfer = [entry.sup_transfer_1, entry.sup_transfer_2].some((transfer) => transfer && transfer.result === 'Pass');
  const isMockCallSession = !entry.supervisor_only;
  const isResumedIncompleteSupTransfer = Boolean(entry.resumed_sup_transfer_only && entry.supervisor_only && status === 'Incomplete');
  const finalized = ['Pass', 'RESUMED-PASS', 'Fail', 'FAIL-Final Attempt', 'NC/NS'].includes(status);

  return matchesTester && (isMockCallSession || isResumedIncompleteSupTransfer) && hasMockCalls && !hasPassedSupTransfer && !finalized;
}

function isMissingBasicsValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === 'n/a' || normalized === 'na' || normalized === 'none' || normalized === 'unknown';
}

function hasUsableBasicsInfo(entry) {
  return buildBasicsFromRecord(entry).usable;
}

function findLatestCandidateBasics(history, candidateName, excludedSessionId = '') {
  return (history || [])
    .filter((entry) => String(sessionIdOf(entry)) !== String(excludedSessionId || ''))
    .filter(hasUsableBasicsInfo)
    .sort((a, b) => sessionDateOf(b).localeCompare(sessionDateOf(a)))
    .find((entry) => normalizeName(entry.candidate_name || entry.candidate) === normalizeName(candidateName)) || null;
}

function applyBasicsToSession(session, basicsSource) {
  return mergeBasicsIntoSession(session, buildBasicsFromRecord(basicsSource));
}

function getHistoricalTechIssueFields(entry = {}) {
  const issue = String(entry.tech_issue || '').trim();
  const issueLogs = Array.isArray(entry.tech_issues_log) ? entry.tech_issues_log : [];
  const hasHistoricalIssue = Boolean(issue && !['N/A', 'No', 'None'].includes(issue)) || issueLogs.length > 0;
  return {
    historical_tech_issue: hasHistoricalIssue ? issue || 'Technical issue recorded in original session' : 'N/A',
    historical_tech_issues_log: issueLogs,
    historical_tech_issue_ended_session: Boolean(entry.tech_issue_ended_session),
    historical_tech_issue_summary_required: Boolean(entry.tech_issue_summary_required),
    historical_other_technical_issue: entry.other_technical_issue || '',
  };
}

export function buildResumedSession(entry) {
  return {
    ...getHistoricalTechIssueFields(entry),
    candidate_name: entry.candidate_name || entry.candidate || '',
    tester_name: entry.tester_name || '',
    pronoun: entry.pronoun || '',
    final_attempt: !!entry.final_attempt,
    supervisor_only: true,
    resumed_sup_transfer_only: true,
    resume_source_history_id: entry.history_id || '',
    resume_source_timestamp_iso: entry.timestamp_iso || '',
    resume_source_candidate: entry.candidate_name || entry.candidate || '',
    resume_source_tester: entry.tester_name || '',
    status: 'In Progress',
    auto_fail_reason: null,
    tech_issue: 'N/A',
    tech_issue_ended_session: false,
    tech_issue_summary_required: false,
    other_technical_issue: '',
    current_session_tech_issue: false,
    headset_usb: entry.headset_usb ?? null,
    headset_brand: entry.headset_brand || '',
    noise_cancel: entry.noise_cancel ?? null,
    vpn_on: entry.vpn_on ?? null,
    vpn_off: entry.vpn_off ?? null,
    chrome_default: entry.chrome_default ?? null,
    extensions_disabled: entry.extensions_disabled ?? null,
    popups_allowed: entry.popups_allowed ?? null,
    call_1: entry.call_1 || null,
    call_2: entry.call_2 || null,
    call_3: entry.call_3 || null,
    sup_transfer_1: null,
    sup_transfer_2: null,
    time_for_sup: true,
    newbie_shift_data: entry.newbie_shift_data || null,
    newbie_shift_scheduled_at: entry.newbie_shift_scheduled_at || '',
    newbie_shift_timezone: entry.newbie_shift_timezone || '',
    newbie_shift_request_id: entry.newbie_shift_request_id || '',
    newbie_shift_request_type: entry.newbie_shift_request_type || '',
    newbie_shift_request_status: entry.newbie_shift_request_status || '',
    newbie_shift_requested_by: entry.newbie_shift_requested_by || '',
    newbie_shift_request_reason: entry.newbie_shift_request_reason || '',
    newbie_shift_request_details: entry.newbie_shift_request_details || '',
    newbie_shift_request_created_at: entry.newbie_shift_request_created_at || '',
    newbie_shift_original_scheduled_at: entry.newbie_shift_original_scheduled_at || '',
    newbie_shift_rescheduled_at: entry.newbie_shift_rescheduled_at || '',
    newbie_shift_within_24_hours: Boolean(entry.newbie_shift_within_24_hours),
    newbie_shift_counts_as_attempt: Boolean(entry.newbie_shift_counts_as_attempt),
    newbie_shift_admin_decision_at: entry.newbie_shift_admin_decision_at || '',
    newbie_shift_admin_decision_by: entry.newbie_shift_admin_decision_by || '',
    newbie_shift_denial_reason: entry.newbie_shift_denial_reason || '',
    final_status: null,
    last_saved: null,
    tech_issues_log: [],
  };
}

function buildSharedPendingSession(entry, testerName, basicsSource = null) {
  const priorSummary = [entry.notes, entry.mock_call_summary].filter(Boolean).join('\n\n');
  return applyBasicsToSession({
    candidate_name: entry.candidate_name || '',
    tester_name: testerName || '',
    pronoun: '',
    final_attempt: Boolean(entry.final_attempt),
    supervisor_only: true,
    resumed_sup_transfer_only: true,
    shared_pending_sup_transfer: true,
    pending_sup_transfer_id: entry.pending_id || '',
    shared_pending_id: entry.pending_id || '',
    resume_source_history_id: entry.original_session_id || '',
    resume_source_timestamp_iso: '',
    resume_source_candidate: entry.candidate_name || '',
    resume_source_tester: entry.original_tester_name || '',
    status: 'In Progress',
    auto_fail_reason: null,
    tech_issue: 'N/A',
    tech_issue_ended_session: false,
    tech_issue_summary_required: false,
    other_technical_issue: '',
    current_session_tech_issue: false,
    historical_tech_issue: 'N/A',
    historical_tech_issues_log: [],
    headset_usb: null,
    headset_brand: '',
    noise_cancel: null,
    vpn_on: null,
    vpn_off: null,
    chrome_default: null,
    extensions_disabled: null,
    popups_allowed: null,
    call_1: entry.call_1_result ? { result: entry.call_1_result } : null,
    call_2: entry.call_2_result ? { result: entry.call_2_result } : null,
    call_3: entry.call_3_result ? { result: entry.call_3_result } : null,
    sup_transfer_1: null,
    sup_transfer_2: null,
    time_for_sup: true,
    newbie_shift_data: entry.newbie_shift_data || null,
    newbie_shift_scheduled_at: entry.newbie_shift_scheduled_at || '',
    newbie_shift_timezone: entry.newbie_shift_timezone || '',
    newbie_shift_request_id: entry.newbie_shift_request_id || '',
    newbie_shift_request_type: entry.newbie_shift_request_type || '',
    newbie_shift_request_status: entry.newbie_shift_request_status || '',
    newbie_shift_requested_by: entry.newbie_shift_requested_by || '',
    newbie_shift_request_reason: entry.newbie_shift_request_reason || '',
    newbie_shift_request_details: entry.newbie_shift_request_details || '',
    newbie_shift_request_created_at: entry.newbie_shift_request_created_at || '',
    newbie_shift_original_scheduled_at: entry.newbie_shift_original_scheduled_at || '',
    newbie_shift_rescheduled_at: entry.newbie_shift_rescheduled_at || '',
    newbie_shift_within_24_hours: Boolean(entry.newbie_shift_within_24_hours),
    newbie_shift_counts_as_attempt: Boolean(entry.newbie_shift_counts_as_attempt),
    newbie_shift_admin_decision_at: entry.newbie_shift_admin_decision_at || '',
    newbie_shift_admin_decision_by: entry.newbie_shift_admin_decision_by || '',
    newbie_shift_denial_reason: entry.newbie_shift_denial_reason || '',
    final_status: null,
    last_saved: null,
    tech_issues_log: [],
    coaching_summary: priorSummary,
    fail_summary: entry.completed_status || '',
    review_notes: entry.notes || '',
  }, basicsSource);
}

export default function HomePage({ onNavigate, settings: initialSettings, history: initialHistory, historyStats: initialStats, startupStatuses, onHistoryRefresh }) {
  const modal = useModal();
  const [settings, setSettings] = useState(initialSettings || {});
  const [stats, setStats] = useState(initialStats || {});
  const [history, setHistory] = useState(initialHistory || []);
  const [showResumeModal, setShowResumeModal] = useState(false);
  const [resumeEntry, setResumeEntry] = useState(null);
  const [sharedPendingEntries, setSharedPendingEntries] = useState([]);
  const [sharedPendingEntry, setSharedPendingEntry] = useState(null);
  const [sharedPendingError, setSharedPendingError] = useState('');
  const settingsRecoveryAttemptedRef = useRef(false);
  const historyRecoveryAttemptedRef = useRef(false);

  const testerName = settings.tester_name || '';
  const testerNames = [settings.tester_name, settings.display_name].filter(Boolean);
  const resumableHistory = useMemo(
    () => history
      .filter((entry) => canResumeForSupTransfer(entry, testerNames))
      .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')),
    [history, testerNames]
  );

  useEffect(() => {
    if (initialSettings) setSettings(initialSettings);
  }, [initialSettings]);

  useEffect(() => {
    if (initialHistory) setHistory(initialHistory);
  }, [initialHistory]);

  useEffect(() => {
    if (initialStats) setStats(initialStats);
  }, [initialStats]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = onHistoryRefresh
          ? await onHistoryRefresh('home-mount')
          : {
              history: await api.getHistory(8000),
              stats: await api.getHistoryStats(8000),
            };
        if (cancelled) return;
        const nextHistory = Array.isArray(result?.history) ? result.history : [];
        setHistory(nextHistory);
        setStats(result?.stats || {});
        console.log('[HOME] fresh history loaded', { count: nextHistory.length });
      } catch (error) {
        console.log('[HOME] fresh history load failed', { error: error?.message || String(error) });
      }
    };
    refresh();
    return () => { cancelled = true; };
  }, [onHistoryRefresh]);

  useEffect(() => {
    const missingName = !(settings.display_name || settings.tester_name);
    const shouldRecover = missingName && ['fallback', 'error'].includes(startupStatuses?.settings);
    if (!shouldRecover || settingsRecoveryAttemptedRef.current) {
      return undefined;
    }

    settingsRecoveryAttemptedRef.current = true;
    const timeoutId = window.setTimeout(async () => {
      const startedAt = Date.now();
      console.log('[HOME] settings recovery started');
      try {
        const nextSettings = await api.getSettings(5000);
        setSettings(nextSettings || {});
        console.log('[HOME] settings recovery succeeded', { durationMs: Date.now() - startedAt });
      } catch (error) {
        console.log('[HOME] settings recovery failed', { durationMs: Date.now() - startedAt, error: error?.message || String(error) });
      }
    }, 3000);

    return () => window.clearTimeout(timeoutId);
  }, [settings.display_name, settings.tester_name, startupStatuses?.settings]);

  useEffect(() => {
    const shouldRecover = history.length === 0 && ['fallback', 'error'].includes(startupStatuses?.history);
    if (!shouldRecover || historyRecoveryAttemptedRef.current) {
      return undefined;
    }

    historyRecoveryAttemptedRef.current = true;
    const timeoutId = window.setTimeout(async () => {
      const startedAt = Date.now();
      console.log('[HOME] history recovery started');
      try {
        const [historyResult, statsResult] = await Promise.allSettled([
          api.getHistory(8000),
          api.getHistoryStats(8000),
        ]);
        if (historyResult.status === 'fulfilled') {
          setHistory(Array.isArray(historyResult.value) ? historyResult.value : []);
        }
        if (statsResult.status === 'fulfilled') {
          setStats(statsResult.value || {});
        }
        console.log('[HOME] history recovery finished', {
          durationMs: Date.now() - startedAt,
          historyOk: historyResult.status === 'fulfilled',
          statsOk: statsResult.status === 'fulfilled',
          historyCount: historyResult.status === 'fulfilled' && Array.isArray(historyResult.value) ? historyResult.value.length : 0,
        });
      } catch (error) {
        console.log('[HOME] history recovery failed', { durationMs: Date.now() - startedAt, error: error?.message || String(error) });
      }
    }, 3000);

    return () => window.clearTimeout(timeoutId);
  }, [history.length, startupStatuses?.history]);

  useEffect(() => {
    const hasIdentity = Boolean((settings.display_name || settings.tester_name || '').trim());
    if (settings?.setup_complete === false || (settings?.setup_complete !== true && !hasIdentity)) return;
    if (window.sessionStorage.getItem('mts-welcome-sound-played') === '1') return;
    playSound('welcome', {
      testerName: settings.tester_name || '',
      displayName: settings.display_name || '',
      setupComplete: settings.setup_complete !== false,
      welcomeVoice: settings.welcome_voice || 'male',
    });
    window.sessionStorage.setItem('mts-welcome-sound-played', '1');
  }, [settings]);

  const name = settings.display_name || settings.tester_name || 'Tester';
  const recent = (history || []).slice(0, 5);
  const statusChips = (status) => {
    const value = String(status || '?').trim();
    if (value === 'Needs Retest / Additional Coaching') {
      return ['Needs Retest', 'Additional Coaching'];
    }
    return [value || '?'];
  };

  const startStandardSession = () => {
    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    onNavigate('basics');
  };

  const startFreshSupTransferOnly = () => {
    window.sessionStorage.setItem(SUP_ONLY_MODE_KEY, '1');
    onNavigate('basics');
  };

  const handleSupTransferOnly = async () => {
    const choice = await modal.showModal({
      type: 'confirm',
      title: 'Supervisor Transfer Only',
      body: 'Choose how to start Supervisor Transfer.<br><br>Use Smart Resume when this candidate has saved mock-call data. Start Supervisor Transfer Only only when directed or when no resume record should be used.',
      buttons: [
        { label: 'Cancel', cls: 'btn-ghost', value: 'cancel' },
        { label: 'Start Supervisor Transfer Only', cls: 'btn-muted', value: 'standalone' },
        { label: 'Use Smart Resume', cls: 'btn-primary', value: 'smart-resume' },
      ],
      icon: 'repeat',
    });

    if (choice === 'standalone') {
      startFreshSupTransferOnly();
      return;
    }
    if (choice !== 'smart-resume') return;

    const originalTester = await modal.confirm(
      'Smart Resume Source',
      'Did you previously conduct the mock call session for this candidate?'
    );

    if (!originalTester) {
      try {
        const response = await api.getSharedPendingSupTransfers();
        if (!response?.ok) {
          await modal.warning(
            'Shared Lookup Unavailable',
            'Shared candidate lookup unavailable. Using local session mode.'
          );
          startFreshSupTransferOnly();
          return;
        }
        const items = Array.isArray(response.items) ? response.items : [];
        if (!items.length) {
          await modal.warning('No Shared Pending Transfers', 'No shared pending supervisor transfer sessions were found. If this is a new local Supervisor Transfer Only session, continue with a fresh setup.');
          startFreshSupTransferOnly();
          return;
        }
        setSharedPendingEntries(items);
        setSharedPendingEntry(items[0]);
        setSharedPendingError('');
      } catch (error) {
        await modal.warning(
          'Shared Lookup Unavailable',
          'Shared candidate lookup unavailable. Using local session mode.'
        );
        startFreshSupTransferOnly();
      }
      return;
    }

    if (!testerName.trim()) {
      await modal.warning('Tester Missing', 'Set your tester name in Settings before resuming a Supervisor Transfer session.');
      return;
    }

    if (history.length === 0) {
      await modal.warning('No Prior Sessions', 'There are no saved mock-call sessions to resume yet.');
      return;
    }

    if (resumableHistory.length === 0) {
      await modal.warning('No Resumable Sessions', `No prior mock-call sessions were found for tester <b>${testerName}</b>.`);
      return;
    }

    setResumeEntry(null);
    setShowResumeModal(true);
  };

  const handleResumeConfirm = async () => {
    if (!resumeEntry) return;

    const confirmed = await modal.confirm(
      'Confirm Resume',
      `Continue with <b>${resumeEntry.candidate || resumeEntry.candidate_name || 'this candidate'}</b> Supervisor Transfer?`
    );
    if (!confirmed) return;

    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    await api.startSession(buildResumedSession(resumeEntry));
    setResumeEntry(null);
    setShowResumeModal(false);
    onNavigate('suptransfer');
  };

  const handleSharedPendingConfirm = async () => {
    if (!sharedPendingEntry) return;
    const confirmed = await modal.confirm(
      'Confirm Shared Resume',
      `Continue supervisor transfer for <b>${sharedPendingEntry.candidate_name || 'this candidate'}</b>?`
    );
    if (!confirmed) return;
    window.sessionStorage.removeItem(SUP_ONLY_MODE_KEY);
    const basicsResult = findBestBasicsRecord([sharedPendingEntry, ...history], sharedPendingEntry.candidate_name, sharedPendingEntry);
    const basicsSource = basicsResult?.record || findLatestCandidateBasics(history, sharedPendingEntry.candidate_name, sharedPendingEntry.original_session_id);
    console.info('[MTS] Pending sup transfer basics recovery', {
      candidate: sharedPendingEntry.candidate_name || '',
      selectedSession: sharedPendingEntry.original_session_id || sharedPendingEntry.pending_id || '',
      basicsFound: Boolean(basicsSource),
      source: basicsResult?.basics?.source || '',
    });
    await api.startSession(buildSharedPendingSession(sharedPendingEntry, testerName || name, basicsSource));
    setSharedPendingEntries([]);
    setSharedPendingEntry(null);
    setSharedPendingError('');
    onNavigate('suptransfer');
  };

  return (
    <div data-testid="home-page" className="mc-home">
      {/* Where am I + session status */}
      <header className="mc-topbar" data-tour="home-header">
        <div className="mc-topbar-id">
          <span className="mc-eyebrow">Mock Testing Suite — Certification</span>
          <h1 className="mc-greeting">Welcome, {name}!</h1>
        </div>
        <div className="mc-session-status">
          {resumableHistory.length > 0 ? (
            <span className="mc-status-chip is-active">
              <span className="mc-status-dot" /> Resume available
            </span>
          ) : (
            <span className="mc-status-chip">
              <span className="mc-status-dot" /> No active session
            </span>
          )}
        </div>
      </header>

      {/* Quick Actions — the visual focus / mission control */}
      <section className="mc-section mc-section-actions">
        <div className="mc-section-head">
          <h3 className="mc-section-title">Quick actions</h3>
          <span className="mc-section-hint">What would you like to do next?</span>
        </div>
        <div className="mc-quick-actions">
          <button className="qa-tile qa-tile-primary" onClick={startStandardSession} data-testid="home-start-btn">
            <span className="qa-icon"><Rocket size={22} strokeWidth={2} /></span>
            <span className="qa-text">
              <span className="qa-title">New session</span>
              <span className="qa-sub">Begin a full mock test</span>
            </span>
          </button>
          <button className="qa-tile" onClick={handleSupTransferOnly} data-testid="home-sup-only-btn">
            <span className="qa-icon qa-icon-green"><Repeat size={20} strokeWidth={2} /></span>
            <span className="qa-text">
              <span className="qa-title">Supervisor transfer</span>
              <span className="qa-sub">Resume or sup-only flow</span>
            </span>
          </button>
          <button className="qa-tile" onClick={() => onNavigate('history')} data-testid="home-history-btn">
            <span className="qa-icon qa-icon-amber"><HistoryIcon size={20} strokeWidth={2} /></span>
            <span className="qa-text">
              <span className="qa-title">Session history</span>
              <span className="qa-sub">Review past results</span>
            </span>
          </button>
          <button className="qa-tile" onClick={() => onNavigate('settings')}>
            <span className="qa-icon qa-icon-slate"><SettingsIcon size={20} strokeWidth={2} /></span>
            <span className="qa-text">
              <span className="qa-title">Settings</span>
              <span className="qa-sub">Configure your app</span>
            </span>
          </button>
          <button className="qa-tile" onClick={() => onNavigate('help')}>
            <span className="qa-icon qa-icon-cyan"><HelpCircle size={20} strokeWidth={2} /></span>
            <span className="qa-text">
              <span className="qa-title">Help</span>
              <span className="qa-sub">Guides & support</span>
            </span>
          </button>
        </div>
      </section>

      {/* Lower grid: statistics + recent activity */}
      <div className="mc-grid">
        <section className="mc-panel">
          <div className="mc-section-head">
            <h3 className="mc-section-title"><BarChart3 size={16} strokeWidth={2.2} /> Today&apos;s statistics</h3>
          </div>
          <div className="stats-row">
            <StatCard label="Total Sessions" value={stats.total || 0} />
            <StatCard label="Pass Rate" value={`${stats.pass_rate || 0}%`} color="var(--color-success)" />
            <StatCard label="NC/NS Rate" value={`${stats.total > 0 ? Math.round((stats.ncns || 0) / stats.total * 100) : 0}%`} color="var(--color-danger)" />
          </div>
        </section>

        <section className="mc-panel mc-panel-activity">
          <div className="mc-section-head">
            <h3 className="mc-section-title"><Activity size={16} strokeWidth={2.2} /> Recent activity</h3>
            {recent.length > 0 && (
              <button className="mc-link-action" onClick={() => onNavigate('history')}>View all</button>
            )}
          </div>
          <div className="mc-activity-list">
            {recent.length > 0 ? recent.map((s, i) => (
              <div
                key={i}
                className="recent-row"
                onClick={() => onNavigate('history', { selectedHistoryRecord: s })}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onNavigate('history', { selectedHistoryRecord: s });
                  }
                }}
                title="Open this history record"
              >
                <span className="recent-date"><Clock3 size={14} strokeWidth={2} /> {s.timestamp || 'Unknown'}</span>
                <span className="recent-name">{s.candidate || 'Unknown'}</span>
                <span className="recent-status-chips" aria-label={`Status: ${s.status || 'Unknown'}`}>
                  {statusChips(s.status).map((chip) => (
                    <StatusChip key={chip} meta={sessionStatusMeta(chip)} />
                  ))}
                  <StatusChip meta={formFillStatusMeta(s.form_fill_status, { legacy: !s.form_fill_status })} />
                  {newbieShiftStatusMeta(s) && (
                    <StatusChip
                      meta={newbieShiftStatusMeta(s)}
                      title={`Newbie Shift: ${formatNewbieSchedule(s.newbie_shift_data)}`}
                    />
                  )}
                </span>
              </div>
            )) : (
              <div className="empty-state">
                <span className="empty-state-icon"><HistoryIcon size={26} strokeWidth={1.75} /></span>
                <div className="empty-state-title">
                  {startupStatuses?.history === 'fallback' || startupStatuses?.history === 'error'
                    ? 'Recent activity unavailable'
                    : 'No sessions yet'}
                </div>
                <div className="empty-state-body">
                  {startupStatuses?.history === 'pending'
                    ? 'Loading your recent sessions…'
                    : startupStatuses?.history === 'fallback' || startupStatuses?.history === 'error'
                      ? 'Recent sessions could not be loaded right now.'
                      : 'Start a mock test and your completed sessions will appear here.'}
                </div>
                {!(startupStatuses?.history === 'pending') && (
                  <button className="btn btn-primary btn-sm" onClick={startStandardSession}>Start a session</button>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {showResumeModal && (
        <ResumeSupTransferModal
          entries={resumableHistory}
          selectedEntry={resumeEntry}
          onSelect={setResumeEntry}
          onClose={() => { setResumeEntry(null); setShowResumeModal(false); }}
          onConfirm={handleResumeConfirm}
        />
      )}
      {(sharedPendingEntries.length > 0 || sharedPendingError) && (
        <SharedPendingSupTransferModal
          entries={sharedPendingEntries}
          selectedEntry={sharedPendingEntry}
          error={sharedPendingError}
          onSelect={setSharedPendingEntry}
          onClose={() => {
            setSharedPendingEntries([]);
            setSharedPendingEntry(null);
            setSharedPendingError('');
          }}
          onConfirm={handleSharedPendingConfirm}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : {}}>{value}</div>
    </div>
  );
}

function StatusChip({ meta, title }) {
  const safe = meta || { label: 'Unknown', title: 'Unknown', ariaLabel: 'Status: Unknown', className: 'status-chip-form-legacy' };
  return (
    <span className={`status-chip recent-status-chip ${safe.className}`} title={title || safe.title || safe.label} aria-label={safe.ariaLabel || safe.label}>
      <span className="status-chip-icon" aria-hidden="true" />
      <span className="status-chip-label">{safe.label}</span>
    </span>
  );
}

export function ResumeSupTransferModal({ entries, selectedEntry, onSelect, onClose, onConfirm }) {
  const [search, setSearch] = useState('');
  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      const candidateName = (entry.candidate || entry.candidate_name || '').toLowerCase();
      const timestamp = (entry.timestamp || '').toLowerCase();
      return candidateName.includes(query) || timestamp.includes(query);
    });
  }, [entries, search]);

  return (
    <div className="modal-overlay open">
      <div className="modal" style={{ width: 760, maxHeight: '85vh' }}>
        <div className="modal-header">
          <h2>Resume Supervisor Transfer</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body" style={{ paddingTop: 0 }}>
          <p className="text-muted" style={{ marginBottom: 16 }}>
            Select the prior mock-call session to continue from.
          </p>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by candidate or date..."
            style={{ marginBottom: 16, width: '100%' }}
            data-testid="resume-sup-search"
          />
          <div className="resume-session-list" role="radiogroup" aria-label="Saved supervisor transfer sessions">
                {filteredEntries.length === 0 && <div className="resume-session-empty">No prior sessions match that search.</div>}
                {filteredEntries.map((entry, index) => {
                  const candidateName = entry.candidate || entry.candidate_name || 'Unknown';
                  const completedCalls = [entry.call_1, entry.call_2, entry.call_3].filter((call) => call && call.result).length;
                  const selected = selectedEntry === entry;
                  return (
                    <label key={`${candidateName}-${entry.timestamp || index}`} className={`resume-session-card ${selected ? 'is-selected' : ''}`}>
                      <span className="resume-session-select">
                        <input
                          type="radio"
                          name="resume-sup-transfer"
                          checked={selected}
                          onChange={() => onSelect(entry)}
                          data-testid={`resume-entry-${index}`}
                        />
                        <span>Select</span>
                      </span>
                      <span className="resume-session-field"><strong>Date</strong><span>{entry.timestamp || 'Unknown'}</span></span>
                      <span className="resume-session-field"><strong>Candidate</strong><span>{candidateName}</span></span>
                      <span className="resume-session-field"><strong>Calls completed</strong><span>{completedCalls}</span></span>
                      <span className="resume-session-field"><strong>Status</strong><span className="badge badge-incomplete">{entry.status || 'Saved'}</span></span>
                    </label>
                  );
                })}
          </div>
        </div>
        <div className="cmodal-btns" style={{ padding: '0 24px 24px' }}>
          <button className="btn btn-muted" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onConfirm} disabled={!selectedEntry} data-testid="resume-sup-confirm">Continue</button>
        </div>
      </div>
    </div>
  );
}

function SharedPendingSupTransferModal({ entries, selectedEntry, error, onSelect, onClose, onConfirm }) {
  const [search, setSearch] = useState('');
  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => (
      String(entry.candidate_name || '').toLowerCase().includes(query)
      || String(entry.original_tester_name || '').toLowerCase().includes(query)
      || String(entry.mock_call_summary || '').toLowerCase().includes(query)
    ));
  }, [entries, search]);

  return (
    <div className="modal-overlay open">
      <div className="modal" style={{ width: 860, maxHeight: '86vh' }}>
        <div className="modal-header">
          <h2>Shared Pending Supervisor Transfers</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body" style={{ paddingTop: 0 }}>
          {error ? (
            <div className="banner banner-fail" style={{ fontSize: 'var(--font-size-sm)', marginBottom: 16 }}>
              {error}
            </div>
          ) : (
            <>
              <p className="text-muted" style={{ marginBottom: 16 }}>
                Select a candidate whose mock calls were completed by another tester and are waiting for supervisor transfer completion.
              </p>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by candidate, original tester, or call summary..."
                style={{ marginBottom: 16, width: '100%' }}
              />
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <table className="hist-table">
                  <thead>
                    <tr><th></th><th>Candidate</th><th>Original Tester</th><th>Calls</th><th>Created</th></tr>
                  </thead>
                  <tbody>
                    {filteredEntries.length === 0 && (
                      <tr>
                        <td colSpan={5} style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)' }}>
                          No shared pending transfers match that search.
                        </td>
                      </tr>
                    )}
                    {filteredEntries.map((entry, index) => (
                      <tr key={`${entry.pending_id || entry.candidate_name || index}`} className="hist-row">
                        <td style={{ width: 44 }}>
                          <input
                            type="radio"
                            name="shared-pending-sup-transfer"
                            checked={selectedEntry === entry}
                            onChange={() => onSelect(entry)}
                          />
                        </td>
                        <td className="hist-name">{entry.candidate_name || 'Unknown'}</td>
                        <td>{entry.original_tester_name || 'Unknown'}</td>
                        <td>{[entry.call_1_result, entry.call_2_result, entry.call_3_result].filter(Boolean).join(', ') || entry.mock_call_summary || 'Recorded'}</td>
                        <td className="hist-date">{entry.created_at || 'Unknown'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {selectedEntry && (
                <div className="card" style={{ marginTop: 16, padding: 16, background: 'var(--bg-card-hover)' }}>
                  <div className="text-sm"><b>Prior call summary:</b> {selectedEntry.mock_call_summary || 'None recorded'}</div>
                  <div className="text-sm" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    <b>Notes:</b> {selectedEntry.notes || 'None recorded'}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="cmodal-btns" style={{ padding: '0 24px 24px' }}>
          <button className="btn btn-muted" onClick={onClose}>Cancel</button>
          {!error && <button className="btn btn-primary" onClick={onConfirm} disabled={!selectedEntry}>Continue</button>}
        </div>
      </div>
    </div>
  );
}
