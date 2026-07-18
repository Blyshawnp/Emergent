import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import { CandidateIpReviewBlock, storeCandidateIpIntelligence } from '../components/CandidateIpIntelligence';
import WorkflowProgress, { getWorkflowProgress } from '../components/WorkflowProgress';
import geminiActiveGraphic from '../assets/images/Gemini2.png';
import { buildBasicsFromRecord, mergeBasicsIntoSession } from '../utils/sessionBasics';
import { displaySummaryLabel } from '../utils/summaryDisplayLabels';
import { buildRescheduleFailSummary, buildRescheduleSummary, getNewbieShiftEligibility, newbieShiftStatusMeta, NEWBIE_REQUEST_STATUS, NEWBIE_REQUEST_TYPE } from '../utils/certificationWorkflow';

const READINESS_NEEDS_RETEST = 'Needs Retest / Additional Coaching';
const READINESS_OVERRIDE_REASONS = [
  'Accuracy/detail concerns',
  'Needed excessive prompting',
  'Caller control concerns',
  'System navigation concerns',
  'Professional tone concerns',
  'Not ready for independent calls',
  'Other',
];
const READINESS_OVERRIDE_RESULTS = ['Pass', 'Fail', READINESS_NEEDS_RETEST];
const FAIL_SUMMARY_STATUSES = new Set(['Fail', 'FAIL-Final Attempt', 'NC/NS', READINESS_NEEDS_RETEST]);

function shouldPopulateFailSummary(finalStatus) {
  return FAIL_SUMMARY_STATUSES.has(finalStatus);
}

function isEmptyTechIssue(value) {
  const text = String(value || '').trim();
  return !text || ['N/A', 'No', 'None'].includes(text);
}

function latestIssueFromLog(log) {
  if (!Array.isArray(log)) return '';
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const issue = String(log[index]?.issue || '').trim();
    if (issue) return issue;
  }
  return '';
}

function getCurrentSessionTechIssue(session) {
  if (!session) return '';
  const resumedSup = Boolean(session.resumed_sup_transfer_only || session.resume_source_history_id || session.resume_source_timestamp_iso);
  if (resumedSup && !session.current_session_tech_issue) return '';
  const issue = String(session.tech_issue || '').trim();
  if (!isEmptyTechIssue(issue)) return issue;
  return latestIssueFromLog(session.tech_issues_log);
}

function getHistoricalSessionTechIssue(session) {
  if (!session) return '';
  const issue = String(session.historical_tech_issue || '').trim();
  if (!isEmptyTechIssue(issue)) return issue;
  return latestIssueFromLog(session.historical_tech_issues_log);
}

function computeCalculatedStatus(session) {
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

  if (session.newbie_shift_request_type === NEWBIE_REQUEST_TYPE.RESCHEDULE && session.newbie_shift_counts_as_attempt) {
    return 'NC/NS';
  }

  if (autoFail) {
    const autoFailText = String(autoFail || '').trim().toLowerCase();
    if (autoFailText.startsWith('nc') || autoFailText.includes('same day drop') || autoFailText.includes('dropped the session within 24 hours')) return 'NC/NS';
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

function normalizeFinalReadinessJudgment(judgment, calculatedResult) {
  const existing = judgment && typeof judgment === 'object' ? judgment : {};
  const overrideApplied = Boolean(existing.overrideApplied);
  return {
    useCalculatedResult: existing.useCalculatedResult !== false && !overrideApplied,
    calculatedResult: calculatedResult || existing.calculatedResult || '',
    overrideApplied,
    overrideResult: existing.overrideResult || '',
    primaryReason: existing.primaryReason || '',
    explanation: existing.explanation || '',
    createdAt: existing.createdAt || '',
    updatedAt: existing.updatedAt || '',
  };
}

function computeFinalStatus(session) {
  if (!session) return 'Fail';
  const calculated = computeCalculatedStatus(session);
  const judgment = normalizeFinalReadinessJudgment(session.finalReadinessJudgment, calculated);
  if (judgment.overrideApplied && READINESS_OVERRIDE_RESULTS.includes(judgment.overrideResult)) {
    return judgment.overrideResult;
  }
  return calculated;
}

function formatReadinessOverrideSummary(judgment) {
  if (!judgment?.overrideApplied) return '';
  const reason = String(judgment.primaryReason || '').trim().replace(/^Evaluator Override Applied:\s*/i, '');
  const parts = [
    `Evaluator Override Applied: calculated result was ${judgment.calculatedResult || 'N/A'} and final result is ${judgment.overrideResult}.`,
  ];
  if (reason) parts.push(`Primary reason: ${reason}.`);
  if (judgment.explanation) parts.push(`Explanation: ${judgment.explanation}`);
  return parts.join(' ');
}

function appendReadinessOverrideSummary(text, judgment) {
  const note = formatReadinessOverrideSummary(judgment);
  if (!note) return text;
  const base = String(text || '').trim();
  if (base.includes('Evaluator Override Applied:')) return base;
  const baseNorm = base.toLowerCase().replace(/\s+/g, ' ').trim();
  const noteNorm = note.toLowerCase().replace(/\s+/g, ' ').trim();
  if (noteNorm && (baseNorm.includes(noteNorm) || baseNorm.endsWith(noteNorm))) return base;
  return base ? `${base}\n\n${note}` : note;
}

function validateReadinessJudgment(judgment) {
  if (!judgment?.overrideApplied) return '';
  if (!READINESS_OVERRIDE_RESULTS.includes(judgment.overrideResult)) return 'Select an override result.';
  if (!judgment.primaryReason) return 'Select a primary reason for the override.';
  if (judgment.primaryReason === 'Other' && !String(judgment.explanation || '').trim()) {
    return 'Enter an explanation when the primary reason is Other.';
  }
  return '';
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
  const finalStatus = session?.final_status || computeFinalStatus(session);
  if (!shouldPopulateFailSummary(finalStatus)) return 'N/A';
  if (saved) return saved;
  return 'No saved fail summary is available for this historical record.';
}

function getFallbackCoachingSummary(session) {
  if (session?.newbie_shift_request_type === NEWBIE_REQUEST_TYPE.RESCHEDULE) {
    return buildRescheduleSummary(session);
  }
  return (session?.coaching_summary || '').trim()
    || buildLocalFallbackCoachingSummary(session);
}

function summarizeSectionForFallback(section, label) {
  if (!section?.result) return '';
  const coaching = Object.entries(section.coaching || {})
    .filter(([, checked]) => checked)
    .map(([item]) => displaySummaryLabel(item))
    .filter(Boolean);
  const fails = Object.entries(section.fails || {})
    .filter(([, checked]) => checked)
    .map(([item]) => displaySummaryLabel(item))
    .filter(Boolean);
  const parts = [`${label}: ${section.result}.`];
  if (coaching.length) parts.push(`Coaching: ${coaching.join(', ')}.`);
  if (fails.length) parts.push(`Fail reasons: ${fails.join(', ')}.`);
  if (section.coach_notes) parts.push(`Notes: ${section.coach_notes}.`);
  return parts.join(' ');
}

function buildLocalFallbackCoachingSummary(session) {
  if (!session) return 'Session summary is being prepared.';
  const lines = [];
  if (!session.supervisor_only) {
    for (let i = 1; i <= 3; i += 1) {
      const line = summarizeSectionForFallback(session[`call_${i}`], `Call ${i}`);
      if (line) lines.push(line);
    }
  }
  for (let i = 1; i <= 2; i += 1) {
    const line = summarizeSectionForFallback(session[`sup_transfer_${i}`], `Supervisor Transfer ${i}`);
    if (line) lines.push(line);
  }
  if (session.auto_fail_reason) {
    lines.push(`Session ended under auto-fail reason: ${session.auto_fail_reason}.`);
  }
  if (session.tech_issue && !isEmptyTechIssue(session.tech_issue)) {
    lines.push(`Technical issue recorded: ${session.tech_issue}.`);
  }
  return lines.length ? lines.join('\n') : 'No coaching items were selected for this session.';
}

function getFallbackFailSummary(session) {
  const saved = (session?.fail_summary || '').trim();
  const finalStatus = session?.final_status || computeFinalStatus(session);
  if (!shouldPopulateFailSummary(finalStatus)) return 'N/A';
  if (session?.newbie_shift_request_type === NEWBIE_REQUEST_TYPE.RESCHEDULE) {
    return buildRescheduleFailSummary(session);
  }
  if (saved) return saved;
  const generated = buildLocalFallbackFailSummary(session);
  return generated || 'No fail summary was generated before Review loaded. You can continue reviewing the session or retry summary generation.';
}

function summarizeFailSectionForFallback(section, label) {
  if (!section || section.result !== 'Fail') return '';
  const failDetails = section.failReasonDetails || section.fail_reason_details || {};
  const fails = Object.entries(section.fails || {})
    .filter(([, checked]) => checked)
    .map(([item]) => {
      const labelText = displaySummaryLabel(item).replace(/\.$/, '');
      const detail = String(failDetails[item] || '').trim();
      return detail ? `${labelText}: ${detail}` : labelText;
    })
    .filter(Boolean);
  if (!fails.length && !section.fail_notes) return '';
  const parts = [`${label} failed.`];
  if (fails.length) parts.push(`Fail reasons: ${fails.join(', ')}.`);
  if (section.fail_notes) parts.push(`Notes: ${section.fail_notes}.`);
  return parts.join(' ');
}

function buildLocalFallbackFailSummary(session) {
  if (!session) return '';
  const lines = [];
  if (!session.supervisor_only) {
    for (let i = 1; i <= 3; i += 1) {
      const line = summarizeFailSectionForFallback(session[`call_${i}`], `Call ${i}`);
      if (line) lines.push(line);
    }
  }
  for (let i = 1; i <= 2; i += 1) {
    const line = summarizeFailSectionForFallback(session[`sup_transfer_${i}`], `Supervisor Transfer ${i}`);
    if (line) lines.push(line);
  }
  if (session.auto_fail_reason) {
    lines.push(`Session ended under auto-fail reason: ${session.auto_fail_reason}.`);
  }
  return lines.join('\n');
}

function getStatusSafeFailSummary(failText, finalStatus, judgment) {
  if (!shouldPopulateFailSummary(finalStatus)) return 'N/A';
  return appendReadinessOverrideSummary(failText, judgment);
}

function getIncompleteReason(session) {
  if (!session) return '';
  const techIssue = getCurrentSessionTechIssue(session);
  if (session.tech_issue_ended_session && techIssue) {
    return 'Technical issue prevented completion during Supervisor Transfer. A Newbie Shift is needed to complete certification.';
  }
  if (session.time_for_sup === false) return 'Supervisor Transfer could not be completed during the current session. A Newbie Shift is needed to complete certification.';
  if (session.newbie_shift_data) {
    return 'Newbie Shift scheduled to complete certification.';
  }
  const supFailed = [session.sup_transfer_1, session.sup_transfer_2].some((transfer) => transfer?.result === 'Fail');
  if (supFailed || session.needs_sup_transfer || session.pending_sup_transfer_id || session.supervisor_only) {
    return 'Supervisor Transfer must be completed during a future Newbie Shift. A Newbie Shift is needed to complete certification.';
  }
  return 'Certification could not be completed in this session.';
}

const SUMMARY_PENDING_MESSAGE = 'Generating summaries...';
const SUMMARY_TIMEOUT_MESSAGE = 'Summary generation timed out. You can continue reviewing the session or retry summary generation.';

function isSummaryPlaceholder(text) {
  if (!text) return true;
  const t = text.trim();
  return (
    t === '' ||
    t === SUMMARY_PENDING_MESSAGE ||
    t === SUMMARY_TIMEOUT_MESSAGE ||
    t.startsWith('No coaching summary was generated before Review loaded') ||
    t.startsWith('No fail summary was generated before Review loaded') ||
    t.startsWith('No saved coaching summary is available') ||
    t.startsWith('No saved fail summary is available') ||
    t === 'Generating review summaries...' ||
    t === 'Loading review...'
  );
}

function getSafeSummaryForSubmit(text, fallback = '') {
  if (isSummaryPlaceholder(text)) {
    return fallback;
  }
  return text;
}

function getSummaryFailureMessage(error, fallback = 'Unable to generate summaries.') {
  const message = error?.response?.data?.detail || error?.message || String(error || fallback);
  const lowered = message.toLowerCase();
  if (lowered.includes('timeout') || lowered.includes('timed out') || lowered.includes('exceeded')) {
    return 'Summary generation timed out. You can continue reviewing the session or retry summary generation.';
  }
  return message || fallback;
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

function formatFinalNotesSummary(notes) {
  if (!notes) return 'No final notes were added.';
  const lines = [];
  if (notes.historyOnly) {
    lines.push("(History-Only Notes - not included in summaries)");
  }
  if (notes.notes?.trim()) lines.push(notes.notes.trim());
  if (notes.strengths?.trim()) lines.push(`Strengths: ${notes.strengths.trim()}`);
  if (notes.needsCoaching?.trim()) lines.push(`Needs Coaching: ${notes.needsCoaching.trim()}`);
  if (notes.other?.trim()) lines.push(`Other Notes: ${notes.other.trim()}`);
  
  if (lines.length === 0) return 'No final notes were added.';
  return lines.join('\n\n');
}

export default function ReviewPage({ onNavigate, navigationState, onHistoryRefresh }) {
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
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryNotice, setSummaryNotice] = useState('');
  const reviewHydratedRef = useRef(false);
  const summaryStartedRef = useRef(false);
  const historyRecord = navigationState?.historyRecord || null;
  const reviewSessionPayload = navigationState?.reviewSession || navigationState?.session || null;
  const isHistoricalReview = Boolean(historyRecord);

  const [isEditingCoaching, setIsEditingCoaching] = useState(false);
  const [tempCoaching, setTempCoaching] = useState('');

  const [isEditingFail, setIsEditingFail] = useState(false);
  const [tempFail, setTempFail] = useState('');

  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [editingNotesText, setEditingNotesText] = useState('');

  const [showRegenInstructionsModal, setShowRegenInstructionsModal] = useState(false);
  const [regenType, setRegenType] = useState('coaching');
  const [regenInstructions, setRegenInstructions] = useState('');

  const [coachingEdited, setCoachingEdited] = useState(false);
  const [failEdited, setFailEdited] = useState(false);
  const [manuallyEdited, setManuallyEdited] = useState(false);

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
          const restoredCalculatedStatus = computeCalculatedStatus(restored);
          const restoredJudgment = normalizeFinalReadinessJudgment(restored.finalReadinessJudgment, restoredCalculatedStatus);
          const restoredFinalStatus = computeFinalStatus({ ...restored, finalReadinessJudgment: restoredJudgment });
          setSettings(currentSettings || {});
          setSession({ ...restored, final_status: restoredFinalStatus, finalReadinessJudgment: restoredJudgment });
          setCoaching((restored.coaching_summary || '').trim());
          setFail((restored.fail_summary || '').trim());
          setLoading(false);
          reviewHydratedRef.current = true;
          return;
        }
        if (!s || !s.candidate_name) { setSession(null); setLoading(false); return; }
        setSettings(currentSettings || {});
        const calculatedStatus = computeCalculatedStatus(s);
        const judgment = normalizeFinalReadinessJudgment(s.finalReadinessJudgment, calculatedStatus);
        const finalStatus = computeFinalStatus({ ...s, finalReadinessJudgment: judgment });
        const resolvedSession = normalizeReviewSession(mergeBasicsIntoSession({ ...s, final_status: finalStatus, finalReadinessJudgment: judgment }, buildBasicsFromRecord(s)));
        setSession(resolvedSession);

        if (!s.final_status || JSON.stringify(s.finalReadinessJudgment || {}) !== JSON.stringify(judgment)) {
          await api.updateSession({ final_status: finalStatus, finalReadinessJudgment: judgment });
        }

        const savedCoaching = (s.coaching_summary || '').trim();
        const savedFail = (s.fail_summary || '').trim();
        const statusSafeSavedFail = shouldPopulateFailSummary(finalStatus) ? savedFail : 'N/A';
        const hasSavedCoaching = Boolean(savedCoaching && !isSummaryPlaceholder(savedCoaching));
        const hasSavedFail = Boolean(statusSafeSavedFail && !isSummaryPlaceholder(statusSafeSavedFail));
        if (hasSavedCoaching && hasSavedFail) {
          setCoaching(savedCoaching);
          setFail(statusSafeSavedFail);
          setLoading(false);
          reviewHydratedRef.current = true;
          return;
        }

        if (summaryStartedRef.current) {
          setLoading(false);
          reviewHydratedRef.current = true;
          return;
        }
        summaryStartedRef.current = true;

        setCoaching(hasSavedCoaching ? savedCoaching : getFallbackCoachingSummary(resolvedSession));
        setFail(hasSavedFail ? statusSafeSavedFail : getFallbackFailSummary(resolvedSession));
        setLoading(false);
        setSummaryLoading(true);
        setSummaryNotice('Generating summaries...');
        reviewHydratedRef.current = true;

        api.generateSummaries(resolvedSession)
          .then((summaries) => {
            if (cancelled) return;
            const nextCoaching = hasSavedCoaching ? savedCoaching : (summaries.coaching || getFallbackCoachingSummary(resolvedSession));
            const nextFail = hasSavedFail ? statusSafeSavedFail : (shouldPopulateFailSummary(finalStatus) ? (summaries.fail || getFallbackFailSummary(resolvedSession)) : 'N/A');
            setCoaching(nextCoaching);
            setFail(nextFail);
            setSummaryDiagnostics(summaries);
            setSummaryNotice(summaries.gemini_error ? getSummaryFailureMessage({ message: summaries.gemini_error }) : '');
            api.updateSession({
              coaching_summary: getSafeSummaryForSubmit(nextCoaching, ''),
              fail_summary: getSafeSummaryForSubmit(nextFail, ''),
            }).catch(() => {});
          })
          .catch((error) => {
            if (cancelled) return;
            const message = getSummaryFailureMessage(error);
            console.log('[REVIEW] summary generation failed', { message });
            setSummaryDiagnostics({ used_gemini: false, used_fallback: true, gemini_error: message });
            setSummaryNotice(message);
            setCoaching((current) => (hasSavedCoaching || !isSummaryPlaceholder(current) ? current : getFallbackCoachingSummary(resolvedSession)));
            setFail((current) => (hasSavedFail || !isSummaryPlaceholder(current) ? current : getFallbackFailSummary(resolvedSession)));
          })
          .finally(() => {
            if (!cancelled) setSummaryLoading(false);
          });
      } catch (err) {
        if (!cancelled) {
          console.log('[REVIEW] failed to load review screen', { error: err?.message || String(err) });
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
      if (!isSummaryPlaceholder(coaching) || !isSummaryPlaceholder(fail)) {
        const autosaveCalculated = computeCalculatedStatus(session);
        const autosaveJudgment = normalizeFinalReadinessJudgment(session.finalReadinessJudgment, autosaveCalculated);
        const autosaveFinalStatus = computeFinalStatus({ ...session, finalReadinessJudgment: autosaveJudgment });
        api.updateSession({
          coaching_summary: getSafeSummaryForSubmit(appendReadinessOverrideSummary(coaching, autosaveJudgment), ''),
          fail_summary: getSafeSummaryForSubmit(getStatusSafeFailSummary(fail, autosaveFinalStatus, autosaveJudgment), ''),
        }).catch(() => {});
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [coaching, fail, isHistoricalReview, session]);

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
  const newbieEligibility = getNewbieShiftEligibility(s);
  const newbie = (newbieEligibility.active || newbieEligibility.denied) ? s.newbie_shift_data : null;

  const calculatedStatus = computeCalculatedStatus(s);
  const finalReadinessJudgment = normalizeFinalReadinessJudgment(s.finalReadinessJudgment, calculatedStatus);
  const finalStatus = computeFinalStatus({ ...s, finalReadinessJudgment });
  const coachingForDisplay = appendReadinessOverrideSummary(coaching, finalReadinessJudgment);
  const failForDisplay = getStatusSafeFailSummary(fail, finalStatus, finalReadinessJudgment);
  const incompleteReason = finalStatus === 'Incomplete' ? getIncompleteReason(s) : '';
  const currentTechIssue = getCurrentSessionTechIssue(s);
  const historicalTechIssue = getHistoricalSessionTechIssue(s);
  const showTechIssueContext = Boolean(currentTechIssue || historicalTechIssue);
  const newbieAlreadyScheduled = Boolean(newbie);
  const newbieSchedulingAllowed = !isHistoricalReview && finalStatus === 'Incomplete' && !autoFail && !s.final_attempt;
  const showNextActions = newbieSchedulingAllowed;
  const canScheduleNewbie = newbieSchedulingAllowed && !newbieAlreadyScheduled;
  let bannerClass, bannerText;
  if (finalStatus === 'Pass' || finalStatus === 'RESUMED-PASS') { bannerClass = 'banner-pass'; bannerText = finalStatus === 'RESUMED-PASS' ? 'RESUMED SESSION PASSED' : 'SESSION PASSED'; }
  else if (finalStatus === 'Incomplete') { bannerClass = 'banner-incomplete'; bannerText = 'SESSION INCOMPLETE - Pending Newbie Shift'; }
  else if (finalStatus === READINESS_NEEDS_RETEST) { bannerClass = 'banner-incomplete'; bannerText = 'NEEDS RETEST / ADDITIONAL COACHING'; }
  else { bannerClass = 'banner-fail'; bannerText = finalStatus === 'FAIL-Final Attempt' ? 'SESSION FAILED - FINAL ATTEMPT' : autoFail ? `AUTO-FAIL: ${autoFail.toUpperCase()}` : 'SESSION FAILED'; }

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

  const refreshSummariesForSession = async (nextSession, notice = SUMMARY_PENDING_MESSAGE) => {
    if (isHistoricalReview || !nextSession?.candidate_name) return;
    summaryStartedRef.current = true;
    setSummaryLoading(true);
    setSummaryNotice(notice);
    try {
      const summaries = await api.generateSummaries(nextSession);
      const nextCoaching = summaries.coaching || getFallbackCoachingSummary(nextSession);
      const nextFinalStatus = computeFinalStatus(nextSession);
      const nextFail = shouldPopulateFailSummary(nextFinalStatus) ? (summaries.fail || getFallbackFailSummary(nextSession)) : 'N/A';
      setCoaching(nextCoaching);
      setFail(nextFail);
      setCoachingEdited(false);
      setFailEdited(false);
      setManuallyEdited(false);
      setSummaryDiagnostics(summaries);
      setSummaryNotice(summaries.gemini_error ? getSummaryFailureMessage({ message: summaries.gemini_error }) : '');
      await api.updateSession({
        coaching_summary: getSafeSummaryForSubmit(nextCoaching, ''),
        fail_summary: getSafeSummaryForSubmit(nextFail, ''),
      }).catch(() => {});
    } catch (error) {
      const message = getSummaryFailureMessage(error);
      console.log('[REVIEW] summary generation failed after readiness change', { message });
      setSummaryDiagnostics({ used_gemini: false, used_fallback: true, gemini_error: message });
      setSummaryNotice(message);
      if (message === SUMMARY_TIMEOUT_MESSAGE) {
        setCoaching((current) => (isSummaryPlaceholder(current) ? SUMMARY_TIMEOUT_MESSAGE : appendReadinessOverrideSummary(current, nextSession.finalReadinessJudgment)));
        setFail((current) => (isSummaryPlaceholder(current) ? SUMMARY_TIMEOUT_MESSAGE : appendReadinessOverrideSummary(current, nextSession.finalReadinessJudgment)));
      }
    } finally {
      setSummaryLoading(false);
    }
  };

  const saveReadinessJudgment = async (nextJudgment) => {
    const normalized = normalizeFinalReadinessJudgment(nextJudgment, calculatedStatus);
    const nextFinalStatus = computeFinalStatus({ ...session, finalReadinessJudgment: normalized });
    const nextSession = { ...session, final_status: nextFinalStatus, finalReadinessJudgment: normalized };
    setSession(nextSession);
    if (!isHistoricalReview) {
      await api.updateSession({
        final_status: nextFinalStatus,
        finalReadinessJudgment: normalized,
      }).catch(() => {});
      await refreshSummariesForSession(nextSession, 'Final Readiness Judgment changed. Regenerating summaries...');
    }
  };

  const handleReadinessUseCalculated = async (useCalculatedResult) => {
    const now = new Date().toISOString();
    if (useCalculatedResult) {
      await saveReadinessJudgment({
        ...finalReadinessJudgment,
        useCalculatedResult: true,
        calculatedResult: calculatedStatus,
        overrideApplied: false,
        overrideResult: '',
        primaryReason: '',
        explanation: '',
        updatedAt: now,
      });
      return;
    }
    await saveReadinessJudgment({
      ...finalReadinessJudgment,
      useCalculatedResult: false,
      calculatedResult: calculatedStatus,
      overrideApplied: true,
      overrideResult: finalReadinessJudgment.overrideResult || '',
      createdAt: finalReadinessJudgment.createdAt || now,
      updatedAt: now,
    });
  };

  const handleReadinessField = async (field, value) => {
    const now = new Date().toISOString();
    await saveReadinessJudgment({
      ...finalReadinessJudgment,
      useCalculatedResult: false,
      calculatedResult: calculatedStatus,
      overrideApplied: true,
      [field]: value,
      createdAt: finalReadinessJudgment.createdAt || now,
      updatedAt: now,
    });
  };

  const handleSaveNotesSummary = async () => {
    setIsEditingNotes(false);
    setSession({ ...session, evaluatorNotesSummaryEdited: editingNotesText });
    await api.updateSession({ evaluatorNotesSummaryEdited: editingNotesText });
  };

  const handleCandidateIpNotesChange = async (notes) => {
    const current = session?.candidate_ip_intelligence;
    if (!current) return;
    const nextIpIntelligence = { ...current, trainerNotes: notes };
    setSession({ ...session, candidate_ip_intelligence: nextIpIntelligence });
    storeCandidateIpIntelligence(nextIpIntelligence);
    if (!isHistoricalReview) {
      await api.updateSession({ candidate_ip_intelligence: nextIpIntelligence }).catch(() => {});
    }
  };

  const handleClearNotes = async () => {
    const confirmed = await modal.confirmDanger(
      'Clear Final Notes',
      'Are you sure you want to remove all final evaluator notes and regenerate summaries?'
    );
    if (!confirmed) return;

    const clearedNotes = {
      notes: '',
      includeInCoachingSummary: true,
      includeInFailSummary: true,
      historyOnly: false,
      completed: false,
      skipped: true
    };
    
    const nextSession = {
      ...session,
      finalEvaluatorNotes: clearedNotes,
      evaluatorNotesSummaryEdited: undefined,
      coaching_summary: '',
      fail_summary: ''
    };
    setSession(nextSession);
    setCoaching('');
    setFail('');
    
    summaryStartedRef.current = true;
    
    await api.updateSession({
      finalEvaluatorNotes: clearedNotes,
      evaluatorNotesSummaryEdited: null,
      coaching_summary: '',
      fail_summary: ''
    });
    
    setSummaryLoading(true);
    setSummaryNotice(SUMMARY_PENDING_MESSAGE);
    try {
      const summaries = await api.generateSummaries(nextSession);
      setCoaching(summaries.coaching || getFallbackCoachingSummary(nextSession));
      setFail(shouldPopulateFailSummary(computeFinalStatus(nextSession)) ? (summaries.fail || getFallbackFailSummary(nextSession)) : 'N/A');
      setSummaryDiagnostics(summaries);
      setSummaryNotice(summaries.gemini_error ? getSummaryFailureMessage({ message: summaries.gemini_error }) : '');
    } catch (error) {
      const message = getSummaryFailureMessage(error);
      setSummaryDiagnostics({ used_gemini: false, used_fallback: true, gemini_error: message });
      setSummaryNotice(message);
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleStartEditNotesSummary = () => {
    const currentText = session.evaluatorNotesSummaryEdited !== undefined
      ? session.evaluatorNotesSummaryEdited
      : formatFinalNotesSummary(session.finalEvaluatorNotes);
    setEditingNotesText(currentText);
    setIsEditingNotes(true);
  };

  const handleCancelNotesSummary = () => {
    setIsEditingNotes(false);
  };

  const handleRegen = async (type) => {
    if (isHistoricalReview) return;
    if (regenerating) return;
    setRegenerating(type);
    setSummaryNotice('');
    try {
      const r = await api.regenerateSummary(type);
      if (r.ok && r.text && !isSummaryPlaceholder(r.text)) {
        if (type === 'coaching') {
          setCoaching(r.text);
          setIsEditingCoaching(false);
        } else {
          setFail(r.text);
          setIsEditingFail(false);
        }
        setManuallyEdited(false);
        setSummaryDiagnostics(r);
      } else {
        await modal.showModal({
          type: 'alert',
          title: 'Regeneration Unavailable',
          body: 'Gemini could not regenerate this summary. Your existing summary was kept.',
          graphic: 'warning',
          buttons: [{ label: 'OK', cls: 'btn-primary', value: true }]
        });
      }
    } catch (e) {
      await modal.showModal({
        type: 'alert',
        title: 'Regeneration Failed',
        body: 'Gemini could not regenerate this summary. Your existing summary was kept.',
        graphic: 'warning',
        buttons: [{ label: 'OK', cls: 'btn-primary', value: true }]
      });
    } finally {
      setRegenerating('');
    }
  };

  const handleRegenWithInstructions = async () => {
    setShowRegenInstructionsModal(false);
    if (isHistoricalReview) return;
    if (regenerating) return;
    setRegenerating(regenType);
    setSummaryNotice('');
    
    const currentVal = regenType === 'coaching' ? coaching : fail;
    try {
      const r = await api.regenerateSummary(regenType, regenInstructions, currentVal);
      if (r.ok && r.text && !isSummaryPlaceholder(r.text)) {
        if (regenType === 'coaching') {
          setCoaching(r.text);
          setIsEditingCoaching(false);
        } else {
          setFail(r.text);
          setIsEditingFail(false);
        }
        setManuallyEdited(false);
        setSummaryDiagnostics(r);
      } else {
        await modal.showModal({
          type: 'alert',
          title: 'Regeneration Unavailable',
          body: 'Gemini could not regenerate this summary. Your existing summary was kept.',
          graphic: 'warning',
          buttons: [{ label: 'OK', cls: 'btn-primary', value: true }]
        });
      }
    } catch (e) {
      console.error('[REVIEW] Summary regeneration failed:', e);
      await modal.showModal({
        type: 'alert',
        title: 'Regeneration Failed',
        body: 'Gemini could not regenerate this summary. Your existing summary was kept.',
        graphic: 'warning',
        buttons: [{ label: 'OK', cls: 'btn-primary', value: true }]
      });
    } finally {
      setRegenerating('');
    }
  };

  const handleRetrySummaries = async () => {
    if (isHistoricalReview || summaryLoading || regenerating) return;
    setSummaryLoading(true);
    setSummaryNotice('Generating summaries...');
    try {
      const r = await api.generateSummaries(session);
      setSummaryDiagnostics(r);
      setCoaching(r.coaching || getFallbackCoachingSummary(session));
      setFail(shouldPopulateFailSummary(finalStatus) ? (r.fail || getFallbackFailSummary(session)) : 'N/A');
      setSummaryNotice(r.gemini_error ? getSummaryFailureMessage({ message: r.gemini_error }) : '');
    } catch (e) {
      const message = getSummaryFailureMessage(e);
      console.log('[REVIEW] retry summary generation failed', { message });
      setSummaryDiagnostics({ used_gemini: false, used_fallback: true, gemini_error: message });
      setSummaryNotice(message);
    } finally {
      setSummaryLoading(false);
    }
  };

  const runFillForm = async ({ showSuccess = true } = {}) => {
    const readinessError = validateReadinessJudgment(finalReadinessJudgment);
    if (readinessError) {
      await modal.warning('Final Readiness Judgment Required', readinessError);
      return false;
    }
    setFilling(true);
    try {
      const sessionForFill = { ...session, final_status: finalStatus, finalReadinessJudgment };
      const r = await api.fillForm(coachingForDisplay, failForDisplay, sessionForFill);
      if (r.ok || r.form_filled || r.automation_completed) {
        setHasFilledForm(true);
        if (r.local_status_saved === false) {
          await api.updateSession({ form_fill_status: 'filled', form_filled_at: new Date().toISOString(), form_fill_error_summary: '' }).catch(() => {});
        }
        if (showSuccess) {
          if (r.warning || r.local_status_saved === false) {
            await modal.warning(
              'Form Filled - Status Warning',
              r.warning || 'The Microsoft Form was filled, but MTS could not update the session status. Do not run Form Fill again. Refresh or update the status manually if needed.'
            );
          } else {
            await modal.alert('Form Filled', r.message || 'The Microsoft Form was filled.', 'check-circle', 'success');
          }
        }
        return true;
      }
      await api.updateSession({ form_fill_status: 'failed', form_fill_error_summary: r.message || 'Form fill failed.' }).catch(() => {});
      await modal.error('Form Fill Failed', r.message || 'Error');
    } catch (e) {
      const data = e?.response?.data || {};
      if (data.form_filled || data.automation_completed) {
        setHasFilledForm(true);
        await api.updateSession({ form_fill_status: 'filled', form_filled_at: new Date().toISOString(), form_fill_error_summary: '' }).catch(() => {});
        await modal.warning(
          'Form Filled - Status Warning',
          data.warning || 'The Microsoft Form was filled, but MTS could not update the session status. Do not run Form Fill again. Refresh or update the status manually if needed.'
        );
        return true;
      }
      await api.updateSession({ form_fill_status: 'failed', form_fill_error_summary: e.message || 'Form fill failed.' }).catch(() => {});
      await modal.error('Error', e.message);
    }
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

    const readinessError = validateReadinessJudgment(finalReadinessJudgment);
    if (readinessError) {
      await modal.warning('Final Readiness Judgment Required', readinessError);
      return;
    }

    if (!hasFilledForm) {
      const fillChoice = await modal.showModal({
        type: 'confirm',
        title: 'Fill Certification Form',
        body: 'Would you like to fill the certification form before closing this session?',
        graphic: 'form',
        buttons: [
          { label: 'No', cls: 'btn-primary', value: 'skip' },
          { label: 'Fill Form', cls: 'btn-warning', value: 'fill' },
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
        { label: 'No', cls: 'btn-muted', value: false },
        { label: 'Yes', cls: 'btn-primary', value: true },
      ],
    });
    if (!confirmed) return;
    setFinishing(true);
    try {
      await api.updateSession({
        final_status: finalStatus,
        finalReadinessJudgment,
        coaching_summary: getSafeSummaryForSubmit(coachingForDisplay, ''),
        fail_summary: getSafeSummaryForSubmit(failForDisplay, ''),
        form_fill_status: hasFilledForm ? 'filled' : 'skipped',
      }).catch(() => {});
      const r = await api.finishSession(coachingForDisplay, failForDisplay);
      if (r.ok) {
        if (onHistoryRefresh) {
          await onHistoryRefresh('review-finish').catch((error) => {
            console.log('[REVIEW] history refresh after session completion failed', { error: error?.message || String(error) });
          });
        }
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
      await api.updateSession({
        final_status: finalStatus,
        finalReadinessJudgment,
        coaching_summary: coachingForDisplay,
        fail_summary: failForDisplay,
      }).catch(() => {});
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
      await modal.error('Discard Failed', e.message || 'Unknown error');
    }
    onNavigate('home');
  };

  const handleScheduleNewbieShift = async () => {
    if (!canScheduleNewbie) return;
    await api.updateSession({
      final_status: finalStatus,
      finalReadinessJudgment,
      fail_summary: 'N/A',
      newbie_shift_prompt: {
        trigger: 'review_backup_action',
        status: 'accepted',
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
    onNavigate('newbieshift');
  };

  const geminiActive = Boolean(settings?.enable_gemini && (settings?.gemini_api_key_configured || String(settings?.gemini_api_key || '').trim()));
  
  const getSummaryStatusText = () => {
    if (isHistoricalReview) return '';
    if (summaryLoading) return SUMMARY_PENDING_MESSAGE;
    
    if (coachingEdited || failEdited || manuallyEdited) {
      return 'Manually edited';
    }

    const isTimeout = summaryDiagnostics?.gemini_error?.toLowerCase().includes('timeout') ||
                      summaryDiagnostics?.gemini_error?.toLowerCase().includes('timed out') ||
                      summaryNotice?.toLowerCase().includes('timeout') ||
                      summaryNotice?.toLowerCase().includes('timed out');
                      
    if (isTimeout) {
      return 'Gemini timed out, so a fallback summary was used. You can retry or regenerate with instructions.';
    }

    if (summaryDiagnostics?.gemini_error || summaryNotice) {
      const err = summaryDiagnostics?.gemini_error || summaryNotice;
      return `Gemini unavailable: ${err}. Using fallback summaries.`;
    }

    if (summaryDiagnostics?.used_gemini) {
      return 'Gemini summary generated';
    }

    if (summaryDiagnostics?.used_fallback) {
      return 'Fallback summary used';
    }

    return '';
  };

  const summaryStatusText = getSummaryStatusText();

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

      {showNextActions && (
        <div className="card" style={{ marginTop: 16 }} data-testid="review-next-actions">
          <h3 style={{ marginBottom: 12 }}>Next Actions</h3>
          <p className="text-sm" style={{ marginTop: 0, marginBottom: 8 }}>
            This certification session requires follow-up before it can be completed.
          </p>
          <p className="text-xs text-muted" style={{ marginTop: 0, marginBottom: 12 }}>
            Use this if the automatic Newbie Shift prompt was skipped, dismissed, or the session was updated after review.
          </p>
          {newbieAlreadyScheduled ? (
            <>
              <button className="btn btn-muted" disabled data-testid="review-newbie-already-scheduled">
                ✓ Newbie Shift Already Scheduled
              </button>
              <div className="text-xs text-muted" style={{ marginTop: 8 }}>
                A Newbie Shift has already been scheduled for this candidate.
              </div>
            </>
          ) : (
            <button
              className="btn btn-primary"
              onClick={handleScheduleNewbieShift}
              disabled={!canScheduleNewbie}
              data-testid="review-schedule-newbie"
            >
              Schedule Newbie Shift
            </button>
          )}
        </div>
      )}

      <div className="card final-readiness-card" data-testid="final-readiness-judgment">
        <div className="final-readiness-header">
          <div>
            <h3>Final Readiness Judgment</h3>
            <div className="text-sm text-muted">Calculated result: <strong>{calculatedStatus}</strong></div>
          </div>
          {finalReadinessJudgment.overrideApplied && (
            <span className="readiness-override-badge">Evaluator Override Applied</span>
          )}
        </div>
        <div className="text-sm font-bold" style={{ marginTop: 12 }}>Do you agree with this calculated result?</div>
        <div className="readiness-radio-row">
          <label className={`radio-label ${isHistoricalReview ? 'disabled' : ''}`}>
            <input
              type="radio"
              name="final-readiness-mode"
              checked={!finalReadinessJudgment.overrideApplied}
              disabled={isHistoricalReview}
              onChange={() => handleReadinessUseCalculated(true)}
            />
            Yes, use calculated result
          </label>
          <label className={`radio-label ${isHistoricalReview ? 'disabled' : ''}`}>
            <input
              type="radio"
              name="final-readiness-mode"
              checked={finalReadinessJudgment.overrideApplied}
              disabled={isHistoricalReview}
              onChange={() => handleReadinessUseCalculated(false)}
            />
            No, override result
          </label>
        </div>
        {finalReadinessJudgment.overrideApplied && (
          <div className="final-readiness-override-grid">
            <label>
              <span>Override result</span>
              <select
                value={finalReadinessJudgment.overrideResult}
                onChange={(event) => handleReadinessField('overrideResult', event.target.value)}
                disabled={isHistoricalReview}
                data-testid="readiness-override-result"
              >
                <option value="">Select result</option>
                {READINESS_OVERRIDE_RESULTS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label>
              <span>Primary reason</span>
              <select
                value={finalReadinessJudgment.primaryReason}
                onChange={(event) => handleReadinessField('primaryReason', event.target.value)}
                disabled={isHistoricalReview}
                data-testid="readiness-primary-reason"
              >
                <option value="">Select reason</option>
                {READINESS_OVERRIDE_REASONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label className="full">
              <span>Additional explanation</span>
              <textarea
                rows={3}
                value={finalReadinessJudgment.explanation}
                onChange={(event) => handleReadinessField('explanation', event.target.value)}
                disabled={isHistoricalReview}
                placeholder="Explain why the calculated result is being overridden."
                data-testid="readiness-explanation"
              />
            </label>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 24 }}>
        <div style={{ lineHeight: 1.7 }}>
          <div className="candidate-header review-candidate-header">
            <span className="candidate-header-label">Candidate:</span> {s.candidate_name}
          </div><br />
          <strong>Tester:</strong> {s.tester_name || 'N/A'}<br />
          <strong>Date:</strong> {reviewSessionDate(s) || 'N/A'}<br />
          <strong>Status:</strong> {finalStatus}<br />
          {finalReadinessJudgment.overrideApplied && <><strong>Calculated Result:</strong> {calculatedStatus}<br /></>}
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
          {showTechIssueContext && (<>
            <strong>Current Session Technical Issue:</strong> {currentTechIssue || 'N/A'}<br />
            {historicalTechIssue && <><strong>Prior Session Technical Issue:</strong> {historicalTechIssue} <span className="text-muted text-xs">(history only)</span><br /></>}
          </>)}
          {autoFail && <><strong>Auto-Fail:</strong> <span style={{ color: 'var(--color-danger)' }}>{autoFail}</span><br /></>}
          {!supOnly && (<>
            <br /><strong>- CALL RESULTS -</strong><br />
            <strong>Call 1:</strong> {colorResult(c1r)}<br />
            <strong>Call 2:</strong> {colorResult(c2r)}<br />
            <strong>Call 3:</strong> {colorResult(c3r)}<br />
          </>)}
          <br /><strong>- SUP TRANSFER RESULTS -</strong><br />
          <strong>Transfer 1:</strong> {colorResult(s1r)}<br />
          <strong>Transfer 2:</strong> {colorResult(s2r)}<br />
          {newbie && (<>
            <br /><strong>- NEWBIE SHIFT -</strong><br />
            <strong>{s.newbie_shift_request_type === NEWBIE_REQUEST_TYPE.RESCHEDULE ? 'Rescheduled Newbie Shift' : 'Date/Time'}:</strong> {newbie.newbie_date || ''} at {newbie.newbie_time || ''} {newbie.newbie_tz || ''}<br />
            {s.newbie_shift_original_scheduled_at && <><strong>Original Scheduled At:</strong> {s.newbie_shift_original_scheduled_at}<br /></>}
            {newbieShiftStatusMeta(s) && <><strong>Reschedule Status:</strong> {newbieShiftStatusMeta(s).label}<br /></>}
            {s.newbie_shift_request_status === NEWBIE_REQUEST_STATUS.DENIED && s.newbie_shift_denial_reason && <><strong>Denial Reason:</strong> {s.newbie_shift_denial_reason}<br /></>}
          </>)}
        </div>
      </div>

      <CandidateIpReviewBlock
        result={s.candidate_ip_intelligence}
        notes={s.candidate_ip_intelligence?.trainerNotes || ''}
        onNotesChange={handleCandidateIpNotesChange}
        readOnly={isHistoricalReview}
        showTrainerNotes
      />

      <div style={{ marginTop: 32 }}>
        {summaryStatusText && (
          <div className="gemini-summary-status" data-testid="review-gemini-status">
            <span>{summaryStatusText}</span>
            {!isHistoricalReview && summaryNotice && !summaryLoading && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleRetrySummaries}
                disabled={Boolean(regenerating)}
                data-testid="review-retry-summary"
              >
                Retry Summary
              </button>
            )}
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
        {!isHistoricalReview && (
          <div className="text-muted text-xs" style={{ marginBottom: 8 }}>
            You can edit this summary before finishing. Use Regenerate with Instructions if you want Gemini to revise the wording.
          </div>
        )}
        {isEditingCoaching ? (
          <>
            <textarea
              className="review-textarea review-textarea-editing"
              rows={6}
              value={tempCoaching}
              onChange={e => setTempCoaching(e.target.value)}
              data-testid="review-coaching"
            />
            <div className="review-btn-row" style={{ marginTop: 8 }}>
              <button
                className="btn btn-success btn-sm"
                onClick={async () => {
                  setCoaching(tempCoaching);
                  setIsEditingCoaching(false);
                  setCoachingEdited(true);
                  await api.updateSession({ coaching_summary: tempCoaching });
                }}
              >
                Save
              </button>
              <button className="btn btn-muted btn-sm" onClick={() => setIsEditingCoaching(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <textarea
              className="review-textarea"
              rows={6}
              value={coachingForDisplay}
              readOnly
              data-testid="review-coaching"
            />
            <div className="review-btn-row" data-tour="review-coaching-actions">
              {!isHistoricalReview && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setTempCoaching(coaching);
                    setIsEditingCoaching(true);
                  }}
                >
                  Edit Coaching Summary
                </button>
              )}
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
              {!isHistoricalReview && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setRegenType('coaching');
                    setRegenInstructions('');
                    setShowRegenInstructionsModal(true);
                  }}
                  disabled={Boolean(regenerating)}
                >
                  Regenerate with Instructions
                </button>
              )}
              <button className="btn btn-primary btn-sm" id="btn-copy-coaching" onClick={() => copyText(coachingForDisplay, 'btn-copy-coaching')} data-testid="review-copy-coaching">Copy</button>
            </div>
          </>
        )}
      </div>

      {incompleteReason && (
        <div className="card" style={{ marginTop: 24 }} data-testid="review-incomplete-reason">
          <h3 style={{ marginBottom: 8 }}>Incomplete Reason</h3>
          <div className="text-sm">{incompleteReason}</div>
        </div>
      )}

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
        {!isHistoricalReview && fail !== 'N/A' && (
          <div className="text-muted text-xs" style={{ marginBottom: 8 }}>
            You can edit this summary before finishing. Use Regenerate with Instructions if you want Gemini to revise the wording.
          </div>
        )}
        {isEditingFail ? (
          <>
            <textarea
              className="review-textarea review-textarea-editing"
              rows={6}
              value={tempFail}
              onChange={e => setTempFail(e.target.value)}
              data-testid="review-fail"
            />
            <div className="review-btn-row" style={{ marginTop: 8 }}>
              <button
                className="btn btn-success btn-sm"
                onClick={async () => {
                  setFail(tempFail);
                  setIsEditingFail(false);
                  setFailEdited(true);
                  await api.updateSession({ fail_summary: tempFail });
                }}
              >
                Save
              </button>
              <button className="btn btn-muted btn-sm" onClick={() => setIsEditingFail(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <textarea
              className="review-textarea"
              rows={6}
              value={failForDisplay}
              readOnly
              data-testid="review-fail"
            />
            <div className="review-btn-row" data-tour="review-fail-actions">
              {!isHistoricalReview && fail !== 'N/A' && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setTempFail(fail);
                    setIsEditingFail(true);
                  }}
                >
                  Edit Fail Summary
                </button>
              )}
              {!isHistoricalReview && fail !== 'N/A' && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleRegen('fail')}
                  disabled={Boolean(regenerating)}
                  data-testid="review-regen-fail"
                >
                  {regenerating === 'fail' ? 'Regenerating...' : 'Regenerate'}
                </button>
              )}
              {!isHistoricalReview && fail !== 'N/A' && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setRegenType('fail');
                    setRegenInstructions('');
                    setShowRegenInstructionsModal(true);
                  }}
                  disabled={Boolean(regenerating)}
                >
                  Regenerate with Instructions
                </button>
              )}
              <button className="btn btn-primary btn-sm" id="btn-copy-fail" onClick={() => copyText(failForDisplay, 'btn-copy-fail')} data-testid="review-copy-fail">Copy</button>
            </div>
          </>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <h3>Evaluator Notes Summary</h3>
        {isEditingNotes ? (
          <>
            <textarea
              className="review-textarea review-textarea-editing"
              rows={4}
              value={editingNotesText}
              onChange={(e) => setEditingNotesText(e.target.value)}
              data-testid="review-notes"
            />
            <div className="review-btn-row" style={{ marginTop: 8 }}>
              <button className="btn btn-success btn-sm" onClick={handleSaveNotesSummary}>Save Notes Summary</button>
              <button className="btn btn-muted btn-sm" onClick={handleCancelNotesSummary}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <textarea
              className="review-textarea"
              rows={4}
              value={
                s.evaluatorNotesSummaryEdited !== undefined
                  ? s.evaluatorNotesSummaryEdited
                  : formatFinalNotesSummary(s.finalEvaluatorNotes)
              }
              readOnly
              data-testid="review-notes"
            />
            {!isHistoricalReview && (
              <div className="review-btn-row" style={{ marginTop: 8, display: 'flex', gap: 10 }}>
                <button className="btn btn-ghost btn-sm" onClick={handleStartEditNotesSummary}>
                  Edit Evaluator Notes Summary
                </button>
                <button className="btn btn-ghost btn-sm" onClick={handleClearNotes} style={{ color: 'var(--color-danger)' }}>
                  Clear/Remove Notes
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Regenerate Summary with Instructions Modal */}
      {showRegenInstructionsModal && (
        <div className="modal-overlay open" style={{ zIndex: 3000 }}>
          <div className="modal" style={{ width: '560px', maxHeight: '80vh' }}>
            <div className="modal-header">
              <h2>Regenerate Summary with Instructions</h2>
            </div>
            <div className="modal-body" style={{ textAlign: 'left' }}>
              <p className="text-muted" style={{ marginBottom: 16 }}>
                Tell Gemini how you want this summary revised.
              </p>
              <textarea
                className="review-textarea"
                style={{ width: '100%', minHeight: '120px', padding: '10px' }}
                value={regenInstructions}
                onChange={(e) => setRegenInstructions(e.target.value)}
                placeholder="Examples:&#10;- Make it shorter.&#10;- Make it warmer and more encouraging.&#10;- Focus more on verification mistakes.&#10;- Mention that the candidate improved on the second call.&#10;- Do not mention the tech issue.&#10;- Make it more direct."
              />
            </div>
            <div className="modal-footer cmodal-btns" style={{ padding: '16px 24px', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button className="btn btn-muted" onClick={() => setShowRegenInstructionsModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleRegenWithInstructions}>Regenerate</button>
            </div>
          </div>
        </div>
      )}

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
