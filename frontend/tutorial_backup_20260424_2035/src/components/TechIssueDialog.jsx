import React, { useState, useCallback, useEffect } from 'react';
import api from '../api';
import { playSound } from '../utils/sound';
import techGraphic from '../assets/images/tech.png';

/*
  TechIssueDialog — Full workflow for technical issues.
  Split into step sub-components to reduce cyclomatic complexity.
*/

const TECH_ISSUES = [
  { id: 'internet', label: 'Internet speed issues' },
  { id: 'calls', label: 'Calls would not route' },
  { id: 'script', label: 'No script pop' },
  { id: 'discord', label: 'Discord issues' },
  { id: 'other', label: 'Other' },
];

// --- Shared helper ---
async function logIssue(issue, resolved) {
  try {
    const { session } = await api.getCurrentSession();
    const log = session?.tech_issues_log || [];
    log.push({ issue, resolved, timestamp: new Date().toISOString() });
    await api.updateSession({ tech_issues_log: log, tech_issue: issue });
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

function SpeedAskStep({ onNext }) {
  return (
    <div>
      <h3 className="ti-title">Internet Speed Issues</h3>
      <p className="ti-body">Did you have the candidate do a speed test?</p>
      <div className="ti-actions">
        <button className="btn btn-muted" onClick={onNext} data-testid="speed-test-no">No, have them do one</button>
        <button className="btn btn-primary" onClick={onNext} data-testid="speed-test-yes">Yes</button>
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

function DteAskStep({ onNo, onYes }) {
  return (
    <div>
      <h3 className="ti-title">Calls Would Not Route</h3>
      <p className="ti-body">Is the candidate's DTE status set to <strong>"Ready"</strong> in the Call Corp Dashboard?</p>
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
      <p className="ti-body">Have them change their DTE status to <strong>"Ready"</strong> in the Call Corp Dashboard.</p>
      <p className="ti-subtitle" style={{ marginTop: 12 }}>Did that resolve the issue?</p>
      <div className="ti-actions">
        <button className="btn btn-danger" onClick={onNo} data-testid="dte-fix-no">No</button>
        <button className="btn btn-success" onClick={onResolved} data-testid="dte-fix-yes">Yes, Resolved</button>
      </div>
    </div>
  );
}

function BrowserAskStep({ onShowSteps, onAlreadyTried }) {
  return (
    <div>
      <h3 className="ti-title">Browser Troubleshooting</h3>
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
  return (
    <div>
      <h3 className="ti-title">Other Technical Issue</h3>
      <p className="ti-subtitle">Describe the issue:</p>
      <textarea className="ti-textarea" value={notes} onChange={e => onNotesChange(e.target.value)} placeholder="Describe the technical issue..." rows={4} data-testid="other-notes-input" />
      <p className="ti-subtitle" style={{ marginTop: 12 }}>Was the issue resolved?</p>
      <div className="ti-actions">
        <button className="btn btn-danger" onClick={onNotResolved} data-testid="other-not-resolved">No</button>
        <button className="btn btn-success" onClick={onResolved} data-testid="other-resolved">Yes, Resolved</button>
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
export default function TechIssueDialog({ open, onClose, isFinalAttempt, onNavigate }) {
  const [step, setStep] = useState('select');
  const [selected, setSelected] = useState({});
  const [otherNotes, setOtherNotes] = useState('');
  const [speedDown, setSpeedDown] = useState('');
  const [speedUp, setSpeedUp] = useState('');
  const [currentIssue, setCurrentIssue] = useState(null);

  const reset = useCallback(() => {
    setStep('select');
    setSelected({});
    setOtherNotes('');
    setSpeedDown('');
    setSpeedUp('');
    setCurrentIssue(null);
  }, []);

  const handleClose = useCallback(() => { reset(); onClose(); }, [reset, onClose]);

  const goToReview = useCallback(() => { handleClose(); onNavigate('review'); }, [handleClose, onNavigate]);
  const goToNewbie = useCallback(() => { handleClose(); onNavigate('newbieshift'); }, [handleClose, onNavigate]);

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
      const stepMap = { internet: 'speed-ask', calls: 'dte-ask', script: 'browser-ask', other: 'other-notes' };
      if (stepMap[nextId]) { setStep(stepMap[nextId]); return; }
      if (nextId === 'discord') { logIssue('Discord issues', true); }
    }
    handleClose();
  }, [selected, currentIssue, handleClose]);

  const processIssues = useCallback(() => {
    const checkedIds = Object.keys(selected).filter(k => selected[k]);
    if (checkedIds.length === 0) return;
    const firstId = checkedIds[0];
    setCurrentIssue(firstId);
    const stepMap = { internet: 'speed-ask', calls: 'dte-ask', script: 'browser-ask', other: 'other-notes' };
    if (stepMap[firstId]) { setStep(stepMap[firstId]); return; }
    if (firstId === 'discord') {
      logIssue('Discord issues', true);
      // Check if more issues
      if (checkedIds.length > 1) {
        const nextId = checkedIds[1];
        setCurrentIssue(nextId);
        if (stepMap[nextId]) { setStep(stepMap[nextId]); return; }
      }
    }
    handleClose();
  }, [selected, handleClose]);

  if (!open) return null;

  const renderContent = () => {
    switch (step) {
      case 'select':
        return <SelectStep selected={selected} onToggle={id => setSelected(prev => ({ ...prev, [id]: !prev[id] }))} onCancel={handleClose} onContinue={processIssues} />;
      case 'speed-ask':
        return <SpeedAskStep onNext={() => setStep('speed-input')} />;
      case 'speed-input':
        return <SpeedInputStep speedDown={speedDown} speedUp={speedUp} onDownChange={setSpeedDown} onUpChange={setSpeedUp} onBack={() => setStep('speed-ask')} onSubmit={() => {
          const dl = parseFloat(speedDown); const ul = parseFloat(speedUp);
          if (isNaN(dl) || isNaN(ul)) return;
          if (dl < 25 || ul < 10) { setStep('speed-fail'); } else { logIssue('Internet speed issues - speeds OK', true); continueToNextIssue(); }
        }} />;
      case 'speed-fail':
        return <SpeedFailStep speedDown={speedDown} speedUp={speedUp} isFinalAttempt={isFinalAttempt} onGoToReview={async () => {
          await logIssue('Internet speed issues - failed speed test', false);
          await api.updateSession({ auto_fail_reason: 'Internet speed too low', final_status: 'Fail' });
          goToReview();
        }} />;
      case 'dte-ask':
        return <DteAskStep onNo={() => setStep('dte-fix')} onYes={() => setStep('browser-ask')} />;
      case 'dte-fix':
        return <DteFixStep onNo={() => setStep('browser-ask')} onResolved={() => { logIssue('Calls would not route - fixed DTE status', true); continueToNextIssue(); }} />;
      case 'browser-ask':
        return <BrowserAskStep onShowSteps={() => setStep('browser-steps')} onAlreadyTried={() => setStep('browser-result')} />;
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
      case 'other-notes':
        return <OtherNotesStep notes={otherNotes} onNotesChange={setOtherNotes} onNotResolved={async () => { await logIssue(`Other: ${otherNotes}`, false); setStep('complete-ask'); }} onResolved={async () => { await logIssue(`Other: ${otherNotes}`, true); continueToNextIssue(); }} />;
      case 'complete-ask':
        return <CompleteAskStep onEndSession={async () => { await api.updateSession({ final_status: 'Fail' }); goToReview(); }} onContinue={handleClose} />;
      default:
        return null;
    }
  };

  return (
    <div className="cmodal-overlay open" data-testid="tech-issue-dialog">
      <div className="cmodal" style={{ maxWidth: 520, width: '90vw', textAlign: 'left' }}>
        <img className="cmodal-graphic" src={techGraphic} alt="" />
        {renderContent()}
      </div>
    </div>
  );
}
