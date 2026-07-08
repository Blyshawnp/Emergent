import React, { useState, useCallback, useEffect } from 'react';
import api from '../api';
import { playSound } from '../utils/sound';
import techGraphic from '../assets/images/tech.png';

/*
  TechIssueDialog — Full workflow for technical issues.
  Split into step sub-components to reduce cyclomatic complexity.
*/

const TECH_ISSUES = [
  { id: 'internet', label: 'Internet Speed Issues' },
  { id: 'calls', label: 'Calls Would Not Route' },
  { id: 'script', label: 'No Script Pop' },
  { id: 'discord', label: 'Discord Issues' },
  { id: 'other', label: 'Other' },
];

// --- Shared helper ---
async function logIssue(issue, resolved, extraSessionFields = {}) {
  try {
    const { session } = await api.getCurrentSession();
    const log = session?.tech_issues_log || [];
    log.push({ issue, resolved, timestamp: new Date().toISOString() });
    await api.updateSession({ tech_issues_log: log, tech_issue: issue, current_session_tech_issue: true, ...extraSessionFields });
  } catch (_err) {
    // Tech issue logging is best-effort; session continues regardless
  }
}

// --- Step Components ---
function SelectStep({ selected, onToggle, onCancel, onContinue }) {
  const anySelected = Object.values(selected).some(v => v);
  return (
    <div>
      <h3 className="ti-title">Technical Issues Log</h3>
      <p className="ti-subtitle">Select all issues that occurred during the session:</p>
      <div className="ti-checklist">
        {TECH_ISSUES.map(issue => (
          <label key={issue.id} className="ti-check-item" data-testid={`tech-issue-${issue.id}`}>
            <input type="checkbox" checked={!!selected[issue.id]} onChange={() => onToggle(issue.id)} />
            <span>{issue.label}</span>
          </label>
        ))}
      </div>
      <div className="ti-actions">
        <button className="btn btn-muted" onClick={onCancel} data-testid="tech-issue-cancel">Cancel</button>
        <button className="btn btn-primary" onClick={onContinue} disabled={!anySelected} data-testid="tech-issue-continue">Continue</button>
      </div>
    </div>
  );
}

function SpeedAskStep({ onNo, onYes }) {
  return (
    <div>
      <h3 className="ti-title">Internet Speed Issues</h3>
      <p className="ti-body">Did you have the candidate do a speed test?</p>
      <div className="ti-actions">
        <button className="btn btn-muted" onClick={onNo} data-testid="speed-test-no">No, have them do one</button>
        <button className="btn btn-primary" onClick={onYes} data-testid="speed-test-yes">Yes</button>
      </div>
    </div>
  );
}

function SpeedInstructionStep({ onOk }) {
  return (
    <div>
      <h3 className="ti-title">Speed Test Required</h3>
      <p className="ti-body">
        Please have the candidate go to the website{' '}
        <a href="https://www.speedtest.net" target="_blank" rel="noreferrer">www.speedtest.net</a>
        {' '}to run a speed test.
      </p>
      <div className="ti-actions">
        <button className="btn btn-primary" onClick={onOk} data-testid="speed-instruction-ok">OK</button>
      </div>
    </div>
  );
}

function SpeedInputStep({ speedDown, speedUp, onDownChange, onUpChange, onBack, onSubmit }) {
  return (
    <div>
      <h3 className="ti-title">Speed Test Results</h3>
      <p className="ti-subtitle">Enter the speed test results:</p>
      <div className="ti-form">
        <div className="ti-field">
          <label>Download Speed (Mbps)</label>
          <input type="number" value={speedDown} onChange={e => onDownChange(e.target.value)} placeholder="e.g. 50" data-testid="speed-download" />
        </div>
        <div className="ti-field">
          <label>Upload Speed (Mbps)</label>
          <input type="number" value={speedUp} onChange={e => onUpChange(e.target.value)} placeholder="e.g. 15" data-testid="speed-upload" />
        </div>
      </div>
      <div className="ti-actions">
        <button className="btn btn-muted" onClick={onBack}>Back</button>
        <button className="btn btn-primary" onClick={onSubmit} data-testid="speed-submit">Check Results</button>
      </div>
    </div>
  );
}

function SpeedFailStep({ speedDown, speedUp, isFinalAttempt, onGoToReview }) {
  const dlFail = parseFloat(speedDown) < 25;
  const ulFail = parseFloat(speedUp) < 10;
  return (
    <div>
      <h3 className="ti-title ti-warn">Speed Test Failed</h3>
      <div className="ti-alert ti-alert-danger">
        <p><strong>Download:</strong> {speedDown} Mbps {dlFail ? '(BELOW 25 Mbps minimum)' : '(OK)'}</p>
        <p><strong>Upload:</strong> {speedUp} Mbps {ulFail ? '(BELOW 10 Mbps minimum)' : '(OK)'}</p>
      </div>
      {isFinalAttempt ? (
        <div className="ti-alert ti-alert-warning">
          <p><strong>FINAL ATTEMPT:</strong> This counts as a fail. Have the candidate email certification for exceptions.</p>
        </div>
      ) : (
        <div className="ti-alert ti-alert-info">
          <p>Internet speeds are too low. Have the candidate reschedule within 24 hours.</p>
        </div>
      )}
      <div className="ti-actions">
        <button className="btn btn-danger" onClick={onGoToReview} data-testid="speed-fail-review">Go to Review</button>
      </div>
    </div>
  );
}

function DteAskStep({ onNo, onYes, isSupervisorTransfer = false }) {
  return (
    <div>
      <h3 className="ti-title">Calls Would Not Route</h3>
      <p className="ti-body">
        {isSupervisorTransfer
          ? <>Does the candidate&apos;s status show as <strong>&quot;Ready&quot;</strong> in the Call Corp Dashboard or Ready on their DTE?</>
          : <>Is the candidate&apos;s DTE status set to <strong>&quot;Ready&quot;</strong> in the Call Corp Dashboard?</>}
      </p>
      <div className="ti-actions">
        <button className="btn btn-danger" onClick={onNo} data-testid="dte-no">No</button>
        <button className="btn btn-primary" onClick={onYes} data-testid="dte-yes">Yes</button>
      </div>
    </div>
  );
}

function DteFixStep({ onNo, onResolved }) {
  return (
    <div>
      <h3 className="ti-title">Fix DTE Status</h3>
      <p className="ti-body">Ask the candidate to change their DTE status to <strong>&quot;Ready&quot;</strong>.</p>
      <p className="ti-subtitle" style={{ marginTop: 12 }}>Did that resolve the issue?</p>
      <div className="ti-actions">
        <button className="btn btn-danger" onClick={onNo} data-testid="dte-fix-no">No</button>
        <button className="btn btn-success" onClick={onResolved} data-testid="dte-fix-yes">Yes, Resolved</button>
      </div>
    </div>
  );
}

function DteStuckStep({ onNo, onYes }) {
  return (
    <div>
      <h3 className="ti-title">DTE Status Check</h3>
      <p className="ti-body">
        Is their DTE status stuck in{' '}
        <strong style={{ color: '#facc15' }}>Full Capacity</strong>
        {' '}or{' '}
        <strong style={{ color: '#ef4444' }}>Ready for Got Calls</strong>?
      </p>
      <div className="ti-actions">
        <button className="btn btn-muted" onClick={onNo} data-testid="dte-stuck-no">No</button>
        <button className="btn btn-primary" onClick={onYes} data-testid="dte-stuck-yes">Yes</button>
      </div>
    </div>
  );
}

function BrowserAskStep({ onShowSteps, onAlreadyTried, title = 'Browser Troubleshooting' }) {
  return (
    <div>
      <h3 className="ti-title">{title}</h3>
      <p className="ti-body">Have you tried having the candidate do the following?</p>
      <ol className="ti-steps">
        <li>Log out of all systems</li>
        <li>Clear browsing data (cache and cookies)</li>
        <li>Close the browser completely</li>
        <li>Sign back in via ACD Direct</li>
      </ol>
      <div className="ti-actions">
        <button className="btn btn-muted" onClick={onShowSteps} data-testid="browser-no">No, show steps</button>
        <button className="btn btn-primary" onClick={onAlreadyTried} data-testid="browser-yes">Yes, already tried</button>
      </div>
    </div>
  );
}

function BrowserStepsStep({ onDone }) {
  return (
    <div>
      <h3 className="ti-title">Follow These Steps</h3>
      <div className="ti-alert ti-alert-info">
        <p>Have the candidate complete these steps in order:</p>
        <ol className="ti-steps">
          <li><strong>Log out</strong> of Call Corp, Simple Script, and Gateway</li>
          <li><strong>Clear browsing data</strong> — Go to browser settings, clear cache and cookies</li>
          <li><strong>Close the browser</strong> completely (all windows)</li>
          <li><strong>Reopen browser</strong> and sign back in via ACD Direct</li>
        </ol>
      </div>
      <p className="ti-subtitle" style={{ marginTop: 12 }}>Have them try these steps now, then click below.</p>
      <div className="ti-actions">
        <button className="btn btn-primary" onClick={onDone} data-testid="browser-steps-done">Done, Check Result</button>
      </div>
    </div>
  );
}

function BrowserResultStep({ onNo, onResolved }) {
  return (
    <div>
      <h3 className="ti-title">Did that resolve the issue?</h3>
      <div className="ti-actions">
        <button className="btn btn-danger" onClick={onNo} data-testid="browser-result-no">No</button>
        <button className="btn btn-success" onClick={onResolved} data-testid="browser-result-yes">Yes, Resolved</button>
      </div>
    </div>
  );
}

function DiscordTroubleshootingStep({ onDone }) {
  return (
    <div>
      <h3 className="ti-title">Discord Troubleshooting</h3>
      <p className="ti-body">Have the candidate complete these checks in Discord:</p>
      <ol className="ti-steps">
        <li>Open <strong>User Settings</strong>, then <strong>Voice &amp; Video</strong></li>
        <li>Select the USB headset for both Input Device and Output Device</li>
        <li>Run the microphone test and confirm the input level responds</li>
        <li>Leave and rejoin the voice channel, then restart Discord if needed</li>
      </ol>
      <div className="ti-actions">
        <button className="btn btn-primary" onClick={onDone} data-testid="discord-steps-done">Done, Check Result</button>
      </div>
    </div>
  );
}

function BrowserFailFinalStep({ onGoToNewbie }) {
  return (
    <div>
      <h3 className="ti-title ti-warn">Final Attempt - Issue Unresolved</h3>
      <div className="ti-alert ti-alert-danger">
        <p><strong>FINAL ATTEMPT:</strong> Ask admins in chat before scheduling a Newbie Shift. Have the candidate email certification for exceptions.</p>
      </div>
      <div className="ti-actions">
        <button className="btn btn-warning" onClick={onGoToNewbie} data-testid="browser-fail-newbie">Go to Newbie Shift</button>
      </div>
    </div>
  );
}

function BrowserFailRescheduleStep({ onGoToNewbie }) {
  return (
    <div>
      <h3 className="ti-title ti-warn">Issue Not Resolved</h3>
      <div className="ti-alert ti-alert-warning">
        <p>The issue could not be resolved. Route to Newbie Shift screen to reschedule.</p>
      </div>
      <div className="ti-actions">
        <button className="btn btn-warning" onClick={onGoToNewbie} data-testid="browser-fail-reschedule-btn">Go to Newbie Shift</button>
      </div>
    </div>
  );
}

function OtherNotesStep({ notes, onNotesChange, onNotResolved, onResolved }) {
  const hasNotes = Boolean(notes.trim());
  return (
    <div>
      <h3 className="ti-title">Other Technical Issue</h3>
      <p className="ti-subtitle">Describe the issue:</p>
      <textarea className="ti-textarea" value={notes} onChange={e => onNotesChange(e.target.value)} placeholder="Describe the technical issue..." rows={4} data-testid="other-notes-input" />
      <p className="ti-subtitle" style={{ marginTop: 12 }}>Was the issue resolved?</p>
      <div className="ti-actions">
        <button className="btn btn-danger" onClick={onNotResolved} disabled={!hasNotes} data-testid="other-not-resolved">No</button>
        <button className="btn btn-success" onClick={onResolved} disabled={!hasNotes} data-testid="other-resolved">Yes, Resolved</button>
      </div>
    </div>
  );
}

function OtherIssueAfterSpeedStep({ notes, onNotesChange, onBack, onContinue }) {
  const hasNotes = Boolean(notes.trim());
  return (
    <div>
      <h3 className="ti-title">Other Technical Issue</h3>
      <p className="ti-subtitle">Describe the technical issue still affecting this session:</p>
      <textarea className="ti-textarea" value={notes} onChange={e => onNotesChange(e.target.value)} placeholder="Describe the issue that remains..." rows={4} data-testid="speed-other-notes-input" />
      <div className="ti-actions">
        <button className="btn btn-muted" onClick={onBack}>Back</button>
        <button className="btn btn-primary" onClick={onContinue} disabled={!hasNotes} data-testid="speed-other-continue">Continue</button>
      </div>
    </div>
  );
}

function SpeedOtherIssueAskStep({ onNo, onYes }) {
  return (
    <div>
      <h3 className="ti-title">Speed Test Passed</h3>
      <p className="ti-body">Are there still other technical issues affecting this session?</p>
      <div className="ti-actions">
        <button className="btn btn-muted" onClick={onNo} data-testid="speed-other-no">No</button>
        <button className="btn btn-primary" onClick={onYes} data-testid="speed-other-yes">Yes</button>
      </div>
    </div>
  );
}

function CompleteAskStep({ onEndSession, onContinue }) {
  return (
    <div>
      <h3 className="ti-title">Session Completion</h3>
      <p className="ti-body">Were you able to complete the session despite the issues?</p>
      <div className="ti-actions">
        <button className="btn btn-danger" onClick={onEndSession} data-testid="complete-no">No - End Session</button>
        <button className="btn btn-success" onClick={onContinue} data-testid="complete-yes">Yes - Continue Session</button>
      </div>
    </div>
  );
}

// --- Main Controller ---
export default function TechIssueDialog({ open, onClose, isFinalAttempt, onNavigate, onBeforeNavigate, context = '' }) {
  const [step, setStep] = useState('select');
  const [selected, setSelected] = useState({});
  const [otherNotes, setOtherNotes] = useState('');
  const [speedDown, setSpeedDown] = useState('');
  const [speedUp, setSpeedUp] = useState('');
  const [currentIssue, setCurrentIssue] = useState(null);
  const isSupervisorTransfer = context === 'suptransfer';
  const isSupervisorRoutingIssue = isSupervisorTransfer && currentIssue === 'calls';

  const candidateReachedSupervisorTransfer = useCallback((session = {}) => Boolean(
    isSupervisorTransfer
    || session.supervisor_only
    || session.sup_transfer_1
    || session.sup_transfer_1_result
    || session.current_sup_transfer_num
    || session.needs_sup_transfer
    || session.pending_sup_transfer_id
  ), [isSupervisorTransfer]);

  const reset = useCallback(() => {
    setStep('select');
    setSelected({});
    setOtherNotes('');
    setSpeedDown('');
    setSpeedUp('');
    setCurrentIssue(null);
  }, []);

  const handleClose = useCallback(() => { reset(); onClose(); }, [reset, onClose]);

  const finalizeTechIssueToReview = useCallback(async (reviewFields = {}, issueLabel = '', resolved = false) => {
    const sourcePage = context || 'calls';
    let preparedSession = null;
    if (onBeforeNavigate) {
      preparedSession = await onBeforeNavigate();
    }
    let current = await api.getCurrentSession().catch(() => null);
    const hadActiveSession = Boolean(current?.session?.candidate_name);
    if (!hadActiveSession && preparedSession?.candidate_name) {
      await api.startSession(preparedSession).catch(() => {});
      current = await api.getCurrentSession().catch(() => null);
    }
    const baseSession = current?.session || preparedSession || {};
    const log = Array.isArray(baseSession.tech_issues_log) ? [...baseSession.tech_issues_log] : [];
    if (issueLabel) {
      log.push({ issue: issueLabel, resolved, timestamp: new Date().toISOString() });
    }
    const reviewSession = {
      ...baseSession,
      ...reviewFields,
      status: reviewFields.status || baseSession.status || 'In Progress',
      tech_issue: reviewFields.tech_issue || issueLabel || baseSession.tech_issue || 'Technical issue unresolved',
      tech_issues_log: log,
      current_session_tech_issue: true,
    };
    console.info('[MTS] Tech issue finalize to Review', {
      type: issueLabel || reviewFields.tech_issue || 'Technical issue',
      sourcePage,
      hadActiveSession,
      reviewSessionCreated: Boolean(reviewSession.candidate_name),
    });
    if (reviewSession.candidate_name) {
      await api.startSession(reviewSession).catch(() => api.updateSession(reviewSession).catch(() => {}));
    } else if (Object.keys(reviewFields || {}).length) {
      await api.updateSession(reviewFields).catch(() => {});
    }
    handleClose();
    onNavigate('review', { reviewSession });
  }, [context, handleClose, onBeforeNavigate, onNavigate]);
  const goToNewbie = useCallback(async () => {
    if (onBeforeNavigate) await onBeforeNavigate();
    const current = await api.getCurrentSession().catch(() => null);
    const session = current?.session || {};
    const issueType = currentIssue === 'calls' ? 'Calls would not route' : 'No script pop';
    if (session.newbie_shift_data) {
      await api.updateSession({
        tech_issue: `${issueType} - unresolved after troubleshooting`,
        tech_issue_ended_session: true,
        tech_issue_summary_required: false,
        current_session_tech_issue: true,
        final_status: 'Incomplete',
        fail_summary: 'N/A',
      }).catch(() => {});
      handleClose();
      onNavigate('review');
      return;
    }
    await api.updateSession({
      tech_issue: `${issueType} - unresolved after troubleshooting`,
      tech_issue_ended_session: true,
      tech_issue_summary_required: false,
      current_session_tech_issue: true,
      final_status: 'Incomplete',
      fail_summary: 'N/A',
      newbie_shift_prompt: {
        trigger: 'technical_issue_sup_transfer',
        status: 'accepted',
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
    handleClose();
    onNavigate('newbieshift');
  }, [currentIssue, handleClose, onBeforeNavigate, onNavigate]);

  const routeUnfinishedSpeedOtherIssue = useCallback(async () => {
    const issue = `Other: ${otherNotes || 'Unresolved technical issue'}`;
    await logIssue(issue, false, { other_technical_issue: otherNotes || 'Unresolved technical issue' });
    const current = await api.getCurrentSession().catch(() => null);
    const session = current?.session || {};
    if (candidateReachedSupervisorTransfer(session) && !isFinalAttempt) {
      if (session.newbie_shift_data) {
        await api.updateSession({
          tech_issue: issue,
          other_technical_issue: otherNotes || 'Unresolved technical issue',
          tech_issue_ended_session: true,
          tech_issue_summary_required: false,
          current_session_tech_issue: true,
          final_status: 'Incomplete',
          fail_summary: 'N/A',
        }).catch(() => {});
        handleClose();
        onNavigate('review');
        return;
      }
      await api.updateSession({
        tech_issue: issue,
        other_technical_issue: otherNotes || 'Unresolved technical issue',
        tech_issue_ended_session: true,
        tech_issue_summary_required: false,
        current_session_tech_issue: true,
        final_status: 'Incomplete',
        fail_summary: 'N/A',
        newbie_shift_prompt: {
          trigger: 'technical_issue_sup_transfer',
          status: 'accepted',
          updated_at: new Date().toISOString(),
        },
      }).catch(() => {});
      handleClose();
      onNavigate('newbieshift');
      return;
    }
    await finalizeTechIssueToReview({
      auto_fail_reason: 'Technical issue unresolved',
      final_status: 'Fail',
      tech_issue: issue,
      other_technical_issue: otherNotes || 'Unresolved technical issue',
      tech_issue_ended_session: true,
      tech_issue_summary_required: true,
      current_session_tech_issue: true,
    }, issue, false);
  }, [candidateReachedSupervisorTransfer, finalizeTechIssueToReview, handleClose, isFinalAttempt, onNavigate, otherNotes]);

  useEffect(() => {
    if (open) {
      playSound('warning');
    }
  }, [open]);

  const continueToNextIssue = useCallback(() => {
    const checkedIds = Object.keys(selected).filter(k => selected[k]);
    const currentIdx = checkedIds.indexOf(currentIssue);
    if (currentIdx < checkedIds.length - 1) {
      const nextId = checkedIds[currentIdx + 1];
      setCurrentIssue(nextId);
      const stepMap = { internet: 'speed-ask', calls: 'dte-ask', script: 'browser-ask', discord: 'discord-steps', other: 'other-notes' };
      if (stepMap[nextId]) { setStep(stepMap[nextId]); return; }
    }
    handleClose();
  }, [selected, currentIssue, handleClose]);

  const processIssues = useCallback(() => {
    const checkedIds = Object.keys(selected).filter(k => selected[k]);
    if (checkedIds.length === 0) return;
    const firstId = checkedIds[0];
    setCurrentIssue(firstId);
    const stepMap = { internet: 'speed-ask', calls: 'dte-ask', script: 'browser-ask', discord: 'discord-steps', other: 'other-notes' };
    if (stepMap[firstId]) { setStep(stepMap[firstId]); return; }
    handleClose();
  }, [selected, handleClose]);

  if (!open) return null;

  const renderContent = () => {
    switch (step) {
      case 'select':
        return <SelectStep selected={selected} onToggle={id => setSelected(prev => ({ ...prev, [id]: !prev[id] }))} onCancel={handleClose} onContinue={processIssues} />;
      case 'speed-ask':
        return <SpeedAskStep onNo={() => setStep('speed-instruction')} onYes={() => setStep('speed-input')} />;
      case 'speed-instruction':
        return <SpeedInstructionStep onOk={() => setStep('speed-input')} />;
      case 'speed-input':
        return <SpeedInputStep speedDown={speedDown} speedUp={speedUp} onDownChange={setSpeedDown} onUpChange={setSpeedUp} onBack={() => setStep('speed-ask')} onSubmit={() => {
          const dl = parseFloat(speedDown); const ul = parseFloat(speedUp);
          if (isNaN(dl) || isNaN(ul)) return;
          if (dl < 25 || ul < 10) { setStep('speed-fail'); } else { logIssue('Internet speed issues - speeds OK', true); setStep('speed-other-ask'); }
        }} />;
      case 'speed-other-ask':
        return <SpeedOtherIssueAskStep onNo={continueToNextIssue} onYes={() => setStep('speed-other-notes')} />;
      case 'speed-other-notes':
        return <OtherIssueAfterSpeedStep notes={otherNotes} onNotesChange={setOtherNotes} onBack={() => setStep('speed-other-ask')} onContinue={() => setStep('speed-complete-ask')} />;
      case 'speed-complete-ask':
        return <CompleteAskStep onEndSession={routeUnfinishedSpeedOtherIssue} onContinue={async () => { await logIssue(`Other: ${otherNotes}`, true, { other_technical_issue: otherNotes }); continueToNextIssue(); }} />;
      case 'speed-fail':
        return <SpeedFailStep speedDown={speedDown} speedUp={speedUp} isFinalAttempt={isFinalAttempt} onGoToReview={async () => {
          await finalizeTechIssueToReview({ auto_fail_reason: 'Internet speed too low', final_status: 'Fail', tech_issue_ended_session: true, tech_issue_summary_required: true }, 'Internet speed issues - failed speed test', false);
        }} />;
      case 'dte-ask':
        return <DteAskStep isSupervisorTransfer={isSupervisorTransfer} onNo={() => setStep('dte-fix')} onYes={() => setStep('browser-ask')} />;
      case 'dte-fix':
        return <DteFixStep onNo={() => setStep(isSupervisorRoutingIssue ? 'dte-stuck' : 'browser-ask')} onResolved={() => { logIssue('Calls would not route - fixed DTE status', true); continueToNextIssue(); }} />;
      case 'dte-stuck':
        return <DteStuckStep
          onNo={() => setStep('browser-ask')}
          onYes={async () => {
            await logIssue('Calls would not route - DTE stuck on Full Capacity / Ready for Got Calls', false, { sup_dte_stuck: true });
            setStep('browser-ask');
          }}
        />;
      case 'browser-ask':
        return <BrowserAskStep title={isSupervisorRoutingIssue ? 'DTE Troubleshooting' : 'Browser Troubleshooting'} onShowSteps={() => setStep('browser-steps')} onAlreadyTried={() => setStep('browser-result')} />;
      case 'browser-steps':
        return <BrowserStepsStep onDone={() => setStep('browser-result')} />;
      case 'browser-result':
        return <BrowserResultStep onNo={async () => {
          const issueType = currentIssue === 'calls' ? 'Calls would not route' : 'No script pop';
          await logIssue(`${issueType} - browser troubleshooting failed`, false);
          setStep(isFinalAttempt ? 'browser-fail-final' : 'browser-fail-reschedule');
        }} onResolved={() => {
          const issueType = currentIssue === 'calls' ? 'Calls would not route' : 'No script pop';
          logIssue(`${issueType} - resolved after browser troubleshooting`, true);
          continueToNextIssue();
        }} />;
      case 'browser-fail-final':
        return <BrowserFailFinalStep onGoToNewbie={goToNewbie} />;
      case 'browser-fail-reschedule':
        return <BrowserFailRescheduleStep onGoToNewbie={goToNewbie} />;
      case 'discord-steps':
        return <DiscordTroubleshootingStep onDone={() => setStep('discord-result')} />;
      case 'discord-result':
        return <BrowserResultStep onNo={async () => {
          await logIssue('Discord issues - troubleshooting did not resolve the issue', false);
          setStep('complete-ask');
        }} onResolved={() => {
          logIssue('Discord issues - resolved after Voice & Video troubleshooting', true);
          continueToNextIssue();
        }} />;
      case 'other-notes':
        return <OtherNotesStep notes={otherNotes} onNotesChange={setOtherNotes} onNotResolved={async () => { await logIssue(`Other: ${otherNotes}`, false); setStep('complete-ask'); }} onResolved={async () => { await logIssue(`Other: ${otherNotes}`, true); continueToNextIssue(); }} />;
      case 'complete-ask':
        return <CompleteAskStep onEndSession={async () => {
          const issue = currentIssue === 'discord' ? 'Discord issues - unresolved' : `Other: ${otherNotes || 'Unresolved technical issue'}`;
          const current = await api.getCurrentSession().catch(() => null);
          const session = current?.session || {};
          if (candidateReachedSupervisorTransfer(session) && !isFinalAttempt) {
            if (session.newbie_shift_data) {
              await api.updateSession({
                tech_issue: issue,
                other_technical_issue: currentIssue === 'other' ? (otherNotes || 'Unresolved technical issue') : undefined,
                tech_issue_ended_session: true,
                tech_issue_summary_required: false,
                current_session_tech_issue: true,
                final_status: 'Incomplete',
                fail_summary: 'N/A',
              }).catch(() => {});
              handleClose();
              onNavigate('review');
              return;
            }
            await api.updateSession({
              tech_issue: issue,
              other_technical_issue: currentIssue === 'other' ? (otherNotes || 'Unresolved technical issue') : undefined,
              tech_issue_ended_session: true,
              tech_issue_summary_required: false,
              current_session_tech_issue: true,
              final_status: 'Incomplete',
              fail_summary: 'N/A',
              newbie_shift_prompt: {
                trigger: 'technical_issue_sup_transfer',
                status: 'accepted',
                updated_at: new Date().toISOString(),
              },
            }).catch(() => {});
            handleClose();
            onNavigate('newbieshift');
            return;
          }
          await finalizeTechIssueToReview({ auto_fail_reason: 'Technical issue unresolved', final_status: 'Fail', tech_issue: issue, tech_issue_ended_session: true, tech_issue_summary_required: true, current_session_tech_issue: true }, issue, false);
        }} onContinue={handleClose} />;
      default:
        return null;
    }
  };

  return (
    <div className="cmodal-overlay open" data-testid="tech-issue-dialog">
      <div className="cmodal ti-modal" style={{ maxWidth: 520, width: '90vw', textAlign: 'left' }}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
        <img className="cmodal-graphic" src={techGraphic} alt="" />
        {renderContent()}
      </div>
    </div>
  );
}
