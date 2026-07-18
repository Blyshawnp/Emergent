import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import { useModal } from '../components/ModalProvider';
import TechIssueDialog from '../components/TechIssueDialog';
import WorkflowProgress, { getWorkflowProgress } from '../components/WorkflowProgress';
import {
  buildNewbieShiftDiscordPost,
  buildRescheduleFailSummary,
  buildRescheduleSummary,
  computeWithin24Hours,
  NEWBIE_REQUESTED_BY,
  NEWBIE_REQUEST_STATUS,
  NEWBIE_REQUEST_TYPE,
  parseScheduledDateTime,
  RESCHEDULE_REASONS,
  splitCandidateFirstName,
} from '../utils/certificationWorkflow';

export default function NewbieShiftPage({ onNavigate }) {
  const modal = useModal();
  const [techOpen, setTechOpen] = useState(false);
  const [isFinal, setIsFinal] = useState(false);
  const [candidateName, setCandidateName] = useState('');
  const [session, setSession] = useState(null);
  const [showRescheduleDialog, setShowRescheduleDialog] = useState(false);
  const [rescheduleRequester, setRescheduleRequester] = useState('');
  const [rescheduleReason, setRescheduleReason] = useState('');
  const [rescheduleDetails, setRescheduleDetails] = useState('');
  const [rescheduleError, setRescheduleError] = useState('');
  const [editableDiscordPost, setEditableDiscordPost] = useState('');
  const [discordPostCustomized, setDiscordPostCustomized] = useState(false);
  const [discordPostVisible, setDiscordPostVisible] = useState(true);
  const [copiedDiscordPost, setCopiedDiscordPost] = useState(false);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const [date, setDate] = useState(tomorrow.toISOString().split('T')[0]);
  const [time, setTime] = useState('');
  const [ampm, setAmpm] = useState('AM');
  const [tz, setTz] = useState('EST (Eastern)');

  useEffect(() => {
    let cancelled = false;
    api.getCurrentSession().then(({ session }) => {
      if (cancelled) return;
      if (session) {
        setSession(session);
        setIsFinal(session.final_attempt || false);
        setCandidateName(session.candidate_name || '');
        const isReschedule = session.newbie_shift_request_type === NEWBIE_REQUEST_TYPE.RESCHEDULE;
        setShowRescheduleDialog(isReschedule && !session.newbie_shift_requested_by);
        setRescheduleRequester(session.newbie_shift_requested_by || '');
        setRescheduleReason(session.newbie_shift_request_reason || '');
        setRescheduleDetails(session.newbie_shift_request_details || '');
        const existing = session.newbie_shift_data || {};
        if (existing.newbie_date) {
          const match = String(existing.newbie_date).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (match) setDate(`${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`);
        }
        if (existing.newbie_time) {
          const timeMatch = String(existing.newbie_time).match(/^(\d{1,2}:\d{2})\s*(AM|PM)$/i);
          if (timeMatch) {
            setTime(timeMatch[1]);
            setAmpm(timeMatch[2].toUpperCase());
          }
        }
        if (existing.newbie_tz) setTz(existing.newbie_tz);
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

  const candidateFirstName = splitCandidateFirstName(candidateName);
  const isReschedule = session?.newbie_shift_request_type === NEWBIE_REQUEST_TYPE.RESCHEDULE;

  const discordPreviewSession = useMemo(() => ({
    ...(session || {}),
    candidate_name: candidateName,
    final_attempt: isFinal,
    newbie_shift_request_type: isReschedule ? NEWBIE_REQUEST_TYPE.RESCHEDULE : NEWBIE_REQUEST_TYPE.INITIAL,
    newbie_shift_requested_by: rescheduleRequester,
    newbie_shift_request_reason: rescheduleReason,
    newbie_shift_request_details: rescheduleDetails,
    newbie_shift_within_24_hours: Boolean(session?.newbie_shift_within_24_hours),
    newbie_shift_data: {
      newbie_date: getFormattedDate(),
      newbie_time: getFormattedTime() || '',
      newbie_tz: tz,
    },
  }), [candidateName, getFormattedDate, getFormattedTime, isFinal, isReschedule, rescheduleDetails, rescheduleReason, rescheduleRequester, session, tz]);

  const generatedDiscordPost = useMemo(
    () => buildNewbieShiftDiscordPost(discordPreviewSession),
    [discordPreviewSession]
  );

  useEffect(() => {
    if (showRescheduleDialog || discordPostCustomized) return;
    setEditableDiscordPost(generatedDiscordPost);
  }, [discordPostCustomized, generatedDiscordPost, showRescheduleDialog]);

  const handleRescheduleDialogContinue = useCallback(async () => {
    if (!rescheduleRequester) {
      setRescheduleError('Select who needed the Newbie Shift rescheduled.');
      return;
    }
    if (!rescheduleReason) {
      setRescheduleError('Select a reason for the reschedule.');
      return;
    }
    if (rescheduleReason === 'Other' && !rescheduleDetails.trim()) {
      setRescheduleError('Enter details when the reason is Other.');
      return;
    }
    const createdAt = new Date().toISOString();
    const originalScheduledAt = session?.newbie_shift_original_scheduled_at
      || session?.newbie_shift_scheduled_at
      || parseScheduledDateTime(session?.newbie_shift_data?.newbie_date, session?.newbie_shift_data?.newbie_time, session?.newbie_shift_data?.newbie_tz)
      || '';
    const within24 = rescheduleRequester === NEWBIE_REQUESTED_BY.CANDIDATE
      ? computeWithin24Hours(originalScheduledAt, createdAt)
      : false;
    const requestId = session?.newbie_shift_request_id || `newbie-${session?.history_id || session?.resume_source_history_id || Date.now()}`;
    const patch = {
      newbie_shift_request_id: requestId,
      newbie_shift_request_type: NEWBIE_REQUEST_TYPE.RESCHEDULE,
      newbie_shift_request_status: NEWBIE_REQUEST_STATUS.PENDING,
      newbie_shift_requested_by: rescheduleRequester,
      newbie_shift_request_reason: rescheduleReason,
      newbie_shift_request_details: rescheduleDetails.trim(),
      newbie_shift_request_created_at: session?.newbie_shift_request_created_at || createdAt,
      newbie_shift_original_scheduled_at: originalScheduledAt,
      newbie_shift_within_24_hours: within24,
      newbie_shift_counts_as_attempt: within24,
      auto_fail_reason: within24 ? 'NC/NS' : session?.auto_fail_reason || null,
      final_status: within24 ? 'NC/NS' : 'Incomplete',
    };
    await api.updateSession(patch);
    const nextSession = { ...(session || {}), ...patch };
    setSession(nextSession);
    setDiscordPostCustomized(false);
    setDiscordPostVisible(true);
    setEditableDiscordPost(buildNewbieShiftDiscordPost({
      ...nextSession,
      newbie_shift_data: discordPreviewSession.newbie_shift_data,
    }));
    setShowRescheduleDialog(false);
    setRescheduleError('');
  }, [discordPreviewSession.newbie_shift_data, rescheduleDetails, rescheduleReason, rescheduleRequester, session]);

  const selectRescheduleRequester = useCallback((value) => {
    setRescheduleRequester(value);
    setRescheduleError('');
  }, []);

  const selectRescheduleReason = useCallback((value) => {
    setRescheduleReason(value);
    setRescheduleError('');
  }, []);

  const handleContinue = useCallback(async () => {
    const ft = getFormattedTime();
    if (!ft) { await modal.warning('Notice', 'Enter a valid time (e.g. 10:30 or 9:45).'); return; }
    const fd = getFormattedDate();
    const scheduledAt = parseScheduledDateTime(fd, ft, tz) || '';
    const patch = {
      newbie_shift_data: { newbie_date: fd, newbie_time: ft, newbie_tz: tz },
      newbie_shift_scheduled_at: scheduledAt,
      newbie_shift_timezone: tz,
      newbie_shift_calendar_created: Boolean(session?.newbie_shift_calendar_created),
    };
    if (isReschedule) {
      patch.newbie_shift_rescheduled_at = scheduledAt;
      patch.newbie_shift_request_status = session?.newbie_shift_request_status || NEWBIE_REQUEST_STATUS.PENDING;
      patch.coaching_summary = buildRescheduleSummary({ ...(session || {}), ...patch });
      patch.fail_summary = buildRescheduleFailSummary({ ...(session || {}), ...patch });
    } else {
      patch.newbie_shift_request_id = session?.newbie_shift_request_id || `newbie-${session?.history_id || session?.resume_source_history_id || Date.now()}`;
      patch.newbie_shift_request_type = NEWBIE_REQUEST_TYPE.INITIAL;
      patch.newbie_shift_request_status = session?.newbie_shift_request_status || NEWBIE_REQUEST_STATUS.PENDING;
      patch.newbie_shift_requested_by = session?.newbie_shift_requested_by || NEWBIE_REQUESTED_BY.TESTER;
      patch.newbie_shift_request_reason = session?.newbie_shift_request_reason || 'Initial Newbie Shift scheduling';
      patch.newbie_shift_request_created_at = session?.newbie_shift_request_created_at || new Date().toISOString();
    }
    const response = await api.updateSession(patch);
    if (isReschedule && response?.requestSaved !== true) {
      await modal.error('Request Not Submitted', response?.error || 'The reschedule request could not be submitted. Your date, time, requester, and reason were preserved. Retry Continue to Review.');
      return;
    }
    onNavigate('review');
  }, [getFormattedTime, getFormattedDate, tz, session, isReschedule, modal, onNavigate]);

  const handleStoppedResponding = useCallback(async () => {
    const confirmed = await modal.confirm(
      'Confirm Auto-Fail',
      `This will Automatically fail ${candidateName} and mark as Stopped Responding in Chat. Do you want to proceed?`,
      'alert-triangle',
      'warning'
    );
    if (!confirmed) return;
    await api.updateSession({ auto_fail_reason: 'Stopped Responding in Chat', final_status: 'Fail' });
    onNavigate('review');
  }, [candidateName, modal, onNavigate]);

  return (
    <div className="page-with-sticky-actions" data-testid="newbieshift-page">
      <WorkflowProgress {...getWorkflowProgress({ page: 'newbieshift' })} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
        <h1 style={{ marginBottom: 0 }}>{isReschedule ? 'Reschedule Newbie Shift' : 'Schedule Newbie Shift'}</h1>
        {candidateName && (
          <div className="candidate-header">
            <span className="candidate-header-label">Candidate:</span> {candidateName}
          </div>
        )}
      </div>
      {isReschedule && (
        <div className="banner banner-incomplete" style={{ fontSize: 'var(--font-size-sm)', marginBottom: 16 }} data-testid="newbie-reschedule-banner">
          Newbie Shift reschedule. Original scheduled time is preserved in history details.
        </div>
      )}
      <div className="card" style={{ padding: 48 }} data-tour="newbie-form">
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
      <div className="newbie-action-row">
        <button className="btn btn-primary" onClick={handleGcal} data-testid="newbie-gcal" title="Opens Google Calendar with a pre-filled event">Add to Google Calendar</button>
      </div>

      {!showRescheduleDialog && (
        <div className="card" style={{ marginTop: 16 }} data-testid="newbie-discord-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <h3 style={{ marginBottom: 0 }}>Temporary Discord Post</h3>
            <button
              type="button"
              className="btn btn-muted btn-sm"
              onClick={() => setDiscordPostVisible((current) => !current)}
              data-testid="newbie-discord-toggle"
            >
              {discordPostVisible ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-sm text-muted" style={{ margin: '8px 0 10px' }}>
            Review and edit this temporary Discord post before copying. Add any required @mentions manually.
          </p>
          {discordPostVisible && (
            <>
              <textarea
                rows={5}
                value={editableDiscordPost}
                onChange={(event) => {
                  setEditableDiscordPost(event.target.value);
                  setDiscordPostCustomized(true);
                }}
                data-testid="newbie-discord-text"
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {discordPostCustomized && (
                  <button
                    type="button"
                    className="btn btn-muted btn-sm"
                    onClick={() => {
                      setEditableDiscordPost(generatedDiscordPost);
                      setDiscordPostCustomized(false);
                    }}
                    data-testid="newbie-discord-reset"
                  >
                    Reset to Generated Text
                  </button>
                )}
                <button
                  type="button"
                  className={`btn btn-primary btn-sm ${copiedDiscordPost ? 'copied' : ''}`}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(editableDiscordPost);
                      setCopiedDiscordPost(true);
                      window.setTimeout(() => setCopiedDiscordPost(false), 3000);
                    } catch (_error) {
                      await modal.warning('Copy Failed', 'Unable to copy this Discord post automatically.');
                    }
                  }}
                  data-testid="newbie-discord-copy"
                >
                  {copiedDiscordPost ? 'Copied' : 'Copy'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {showRescheduleDialog && (
        <div className="modal-overlay open" data-testid="reschedule-dialog">
          <div
            className="modal"
            style={{ width: 760, maxHeight: '88vh' }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onNavigate('history');
              }
            }}
          >
            <div className="modal-header">
              <h2><span className="reschedule-question-icon" aria-hidden="true">R</span> Newbie Shift Reschedule</h2>
            </div>
            <div className="modal-body">
              <div className="reschedule-card" style={{ marginBottom: 14 }}>
                <h3 className="reschedule-question"><span className="reschedule-question-icon" aria-hidden="true">1</span> Did you or {candidateFirstName} need the Newbie Shift rescheduled?</h3>
                <div className="reschedule-requester-grid" role="radiogroup" aria-label={`Did you or ${candidateFirstName} need the Newbie Shift rescheduled?`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={rescheduleRequester === NEWBIE_REQUESTED_BY.TESTER}
                    className={`reschedule-radio-card ${rescheduleRequester === NEWBIE_REQUESTED_BY.TESTER ? 'is-selected' : ''}`}
                    onClick={() => selectRescheduleRequester(NEWBIE_REQUESTED_BY.TESTER)}
                    data-testid="reschedule-requester-tester"
                  >
                    <span className="reschedule-radio-mark" aria-hidden="true" />
                    <span>Myself</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={rescheduleRequester === NEWBIE_REQUESTED_BY.CANDIDATE}
                    className={`reschedule-radio-card ${rescheduleRequester === NEWBIE_REQUESTED_BY.CANDIDATE ? 'is-selected' : ''}`}
                    onClick={() => selectRescheduleRequester(NEWBIE_REQUESTED_BY.CANDIDATE)}
                    data-testid="reschedule-requester-candidate"
                  >
                    <span className="reschedule-radio-mark" aria-hidden="true" />
                    <span>{candidateFirstName}</span>
                  </button>
                </div>
              </div>
              <div className="reschedule-card">
                <h3 className="reschedule-question"><span className="reschedule-question-icon" aria-hidden="true">2</span> What is the reason that this Newbie Shift must be rescheduled?</h3>
                <div className="reschedule-reason-grid" role="radiogroup" aria-label="What is the reason that this Newbie Shift must be rescheduled?">
                  {RESCHEDULE_REASONS.map((reason) => (
                    <button
                      key={reason}
                      type="button"
                      role="radio"
                      aria-checked={rescheduleReason === reason}
                      className={`reschedule-radio-card ${rescheduleReason === reason ? 'is-selected' : ''}`}
                      onClick={() => selectRescheduleReason(reason)}
                      data-testid={`reschedule-reason-${reason.toLowerCase().replace(/\s+/g, '-')}`}
                    >
                      <span className="reschedule-radio-mark" aria-hidden="true" />
                      <span>{reason}</span>
                    </button>
                  ))}
                </div>
                <label className="reschedule-details-label" htmlFor="reschedule-details">
                  <span>Additional details</span>
                  {rescheduleReason === 'Other' && <span className="reschedule-required">Required for Other</span>}
                </label>
                <textarea
                  id="reschedule-details"
                  rows={3}
                  value={rescheduleDetails}
                  onChange={(event) => setRescheduleDetails(event.target.value)}
                  placeholder={rescheduleReason === 'Other' ? 'Enter the required details for Other.' : 'Optional details'}
                  aria-required={rescheduleReason === 'Other'}
                  data-testid="reschedule-details"
                />
              </div>
              {rescheduleError && <div className="banner banner-fail" style={{ marginTop: 12 }}>{rescheduleError}</div>}
            </div>
            <div className="cmodal-btns" style={{ padding: '0 24px 24px' }}>
              <button type="button" className="btn btn-muted" onClick={() => onNavigate('history')} data-testid="reschedule-cancel">Cancel</button>
              <button type="button" className="btn btn-danger-outline" onClick={async () => {
                if (await modal.confirmDanger('Discard Session', 'Discard this reschedule draft? The saved history record will remain unchanged.')) {
                  await api.discardSession();
                  onNavigate('history');
                }
              }} data-testid="reschedule-discard">Discard</button>
              <button type="button" className="btn btn-primary" onClick={handleRescheduleDialogContinue} data-testid="reschedule-continue">Continue</button>
            </div>
          </div>
        </div>
      )}

      <TechIssueDialog open={techOpen} onClose={() => setTechOpen(false)} isFinalAttempt={isFinal} onNavigate={onNavigate} />

      <div className="footer-bar sticky-action-footer" data-testid="newbie-footer">
        <button className="btn btn-muted btn-sm" onClick={async () => {
          if (await modal.confirm('Confirm', 'Discard session and lose all progress?')) { await api.discardSession(); onNavigate('home'); }
        }} data-testid="newbie-discard" title="Discard this session completely">Discard</button>
        <button className="btn btn-danger btn-sm" onClick={handleStoppedResponding} data-testid="newbie-stopped" title="Candidate stopped responding in Discord">Stopped Responding</button>
        <button className="btn btn-muted btn-sm" onClick={() => setTechOpen(true)} data-testid="newbie-tech" title="Log a technical issue">Tech Issue</button>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={handleContinue} data-testid="newbie-continue" title="Save newbie shift and go to review">Continue to Review</button>
      </div>
    </div>
  );
}
