import {
  normalizeName,
  logicalResumeSourceId,
  canResumeForSupTransfer,
  canonicalResumableHistory,
  getHistoricalTechIssueFields,
  buildResumedSession,
  buildSharedPendingSession,
  buildFailedCandidateRetrySession,
  getCandidateLatestSessionMap,
  isRecordSuperseded,
  canHistoryStartSession,
  canHistorySupervisorTransferOnly,
} from './sessionResume';

describe('sessionResume utility functions', () => {
  describe('normalizeName', () => {
    it('trims, collapses spaces, and lowercases names', () => {
      expect(normalizeName('  Jane   Doe  ')).toBe('jane doe');
      expect(normalizeName('')).toBe('');
      expect(normalizeName(null)).toBe('');
    });
  });

  describe('logicalResumeSourceId', () => {
    it('resolves the correct identifier priority', () => {
      expect(logicalResumeSourceId({ resume_source_history_id: 'src-1', session_id: 's-1' })).toBe('src-1');
      expect(logicalResumeSourceId({ source_session_id: 'src-2', history_id: 'h-2' })).toBe('src-2');
      expect(logicalResumeSourceId({ history_id: 'h-3', session_id: 's-3' })).toBe('h-3');
      expect(logicalResumeSourceId({ session_id: 's-4' })).toBe('s-4');
      expect(logicalResumeSourceId({})).toBe('');
    });
  });

  describe('canResumeForSupTransfer', () => {
    const validEntry = {
      status: 'Incomplete',
      tester_name: 'Alice Smith',
      call_1: { result: 'Pass' },
      call_2: { result: 'Pass' },
      call_3: { result: 'Pass' },
      sup_transfer_1: null,
      supervisor_only: false,
    };

    it('returns true when candidate matches tester, has mock calls, and is not finalized', () => {
      expect(canResumeForSupTransfer(validEntry, ['Alice Smith'])).toBe(true);
    });

    it('returns false when tester does not match', () => {
      expect(canResumeForSupTransfer(validEntry, ['Bob Jones'])).toBe(false);
    });

    it('returns false when already passed supervisor transfer', () => {
      const entry = { ...validEntry, sup_transfer_1: { result: 'Pass' } };
      expect(canResumeForSupTransfer(entry, ['Alice Smith'])).toBe(false);
    });

    it('returns false when finalized status', () => {
      expect(canResumeForSupTransfer({ ...validEntry, status: 'Pass' }, ['Alice Smith'])).toBe(false);
      expect(canResumeForSupTransfer({ ...validEntry, status: 'Fail' }, ['Alice Smith'])).toBe(false);
      expect(canResumeForSupTransfer({ ...validEntry, status: 'NC/NS' }, ['Alice Smith'])).toBe(false);
    });

    it('returns false for schedule only or completed continuation', () => {
      expect(canResumeForSupTransfer({ ...validEntry, schedule_only: true }, ['Alice Smith'])).toBe(false);
      expect(canResumeForSupTransfer({ ...validEntry, supervisor_transfer_completed: true }, ['Alice Smith'])).toBe(false);
    });
  });

  describe('canonicalResumableHistory', () => {
    it('deduplicates and sorts eligible history records descending by timestamp', () => {
      const history = [
        { history_id: 'rec-1', timestamp_iso: '2026-09-01T10:00:00Z', status: 'Incomplete', tester_name: 'Alice', call_1: { result: 'Pass' } },
        { history_id: 'rec-2', timestamp_iso: '2026-09-02T10:00:00Z', status: 'Incomplete', tester_name: 'Alice', call_1: { result: 'Pass' } },
        { history_id: 'rec-1', timestamp_iso: '2026-09-01T10:00:00Z', status: 'Incomplete', tester_name: 'Alice', call_1: { result: 'Pass' } },
      ];
      const result = canonicalResumableHistory(history, ['Alice']);
      expect(result).toHaveLength(2);
      expect(result[0].history_id).toBe('rec-2');
      expect(result[1].history_id).toBe('rec-1');
    });
  });

  describe('getHistoricalTechIssueFields', () => {
    it('returns default N/A when no issues recorded', () => {
      const fields = getHistoricalTechIssueFields({});
      expect(fields.historical_tech_issue).toBe('N/A');
      expect(fields.historical_tech_issues_log).toEqual([]);
      expect(fields.historical_tech_issue_ended_session).toBe(false);
    });

    it('preserves historical issues when present', () => {
      const fields = getHistoricalTechIssueFields({
        tech_issue: 'Mic disconnect',
        tech_issues_log: [{ issue: 'Mic disconnect' }],
        tech_issue_ended_session: true,
      });
      expect(fields.historical_tech_issue).toBe('Mic disconnect');
      expect(fields.historical_tech_issues_log).toHaveLength(1);
      expect(fields.historical_tech_issue_ended_session).toBe(true);
    });
  });

  describe('buildResumedSession', () => {
    it('preserves supervisor-transfer-only flags and linkages with original tester', () => {
      const entry = {
        candidate_name: 'Charlie Test',
        tester_name: 'Alice Smith',
        history_id: 'hist-123',
        newbie_shift_request_id: 'req-999',
        call_1: { result: 'Pass' },
      };
      const session = buildResumedSession(entry);
      expect(session.candidate_name).toBe('Charlie Test');
      expect(session.tester_name).toBe('Alice Smith');
      expect(session.supervisor_only).toBe(true);
      expect(session.resumed_sup_transfer_only).toBe(true);
      expect(session.resume_source_history_id).toBe('hist-123');
      expect(session.resume_source_tester).toBe('Alice Smith');
      expect(session.newbie_shift_request_id).toBe('req-999');
      expect(session.call_1).toEqual({ result: 'Pass' });
    });

    it('assigns currentTester when passed while preserving resume_source_tester', () => {
      const entry = {
        candidate_name: 'Charlie Test',
        tester_name: 'Alice Smith',
        history_id: 'hist-123',
      };
      const session = buildResumedSession(entry, 'Bob Jones');
      expect(session.tester_name).toBe('Bob Jones');
      expect(session.resume_source_tester).toBe('Alice Smith');
    });
  });

  describe('buildSharedPendingSession', () => {
    it('constructs cross-tester pending session with notes and supervisor_only mode', () => {
      const entry = {
        candidate_name: 'Dave Test',
        original_tester_name: 'Alice Smith',
        pending_id: 'pend-123',
        notes: 'Needs supervisor review for tone',
        call_1_result: 'Pass',
      };
      const session = buildSharedPendingSession(entry, 'Bob Jones');
      expect(session.candidate_name).toBe('Dave Test');
      expect(session.tester_name).toBe('Bob Jones');
      expect(session.supervisor_only).toBe(true);
      expect(session.shared_pending_sup_transfer).toBe(true);
      expect(session.pending_sup_transfer_id).toBe('pend-123');
      expect(session.resume_source_tester).toBe('Alice Smith');
      expect(session.call_1).toEqual({ result: 'Pass' });
      expect(session.review_notes).toBe('Needs supervisor review for tone');
    });
  });

  describe('buildFailedCandidateRetrySession', () => {
    it('starts normal certification workflow at Basics without supervisor-only or stale newbie shift fields', () => {
      const record = {
        candidate_name: 'Eve Failure',
        candidate_id: 'cand-001',
        source_candidate_id: 'cand-001',
        tester_name: 'Alice Smith',
        attempt_number: 1,
        prior_counted_attempts: 1,
        history_id: 'fail-session-1',
        status: 'Fail',
        call_1: { result: 'Fail' },
        newbie_shift_request_id: 'stale-req-123',
        newbie_shift_scheduled_at: '2026-09-10T14:00:00Z',
        headset_brand: 'Logitech H390',
        headset_usb: true,
      };

      const retrySession = buildFailedCandidateRetrySession(record, 'Bob Jones');

      // Normal certification workflow
      expect(retrySession.supervisor_only).toBe(false);
      expect(retrySession.resumed_sup_transfer_only).toBe(false);
      expect(retrySession.candidate_name).toBe('Eve Failure');
      expect(retrySession.candidate_id).toBe('cand-001');
      expect(retrySession.source_candidate_id).toBe('cand-001');

      // Attempt increment & history
      expect(retrySession.attempt_number).toBe(2);
      expect(retrySession.prior_counted_attempts).toBe(1);
      expect(retrySession.attempt_history).toHaveLength(1);
      expect(retrySession.attempt_history[0].attempt_number).toBe(1);
      expect(retrySession.attempt_history[0].status).toBe('Fail');
      expect(retrySession.attempt_history[0].tester_name).toBe('Alice Smith');

      // Tester assignment & attribution
      expect(retrySession.tester_name).toBe('Bob Jones');
      expect(retrySession.resume_source_tester).toBe('Alice Smith');
      expect(retrySession.smart_resumed).toBe(true);

      // Clean session calls
      expect(retrySession.call_1).toBeNull();
      expect(retrySession.call_2).toBeNull();
      expect(retrySession.call_3).toBeNull();
      expect(retrySession.sup_transfer_1).toBeNull();

      // Zero stale newbie shift fields copied
      expect(retrySession.newbie_shift_request_id).toBe('');
      expect(retrySession.newbie_shift_scheduled_at).toBe('');
      expect(retrySession.newbie_shift_data).toBeNull();

      // Basics recovered
      expect(retrySession.headset_brand).toBe('Logitech H390');
      expect(retrySession.headset_usb).toBe(true);
    });

    it('marks smart_resumed false if same tester', () => {
      const record = {
        candidate_name: 'Eve Failure',
        tester_name: 'Alice Smith',
        status: 'Fail',
      };
      const retrySession = buildFailedCandidateRetrySession(record, 'Alice Smith');
      expect(retrySession.smart_resumed).toBe(false);
      expect(retrySession.tester_name).toBe('Alice Smith');
    });
  });

  describe('getCandidateLatestSessionMap and isRecordSuperseded', () => {
    it('correctly maps the latest session for each candidate', () => {
      const history = [
        { history_id: 'rec-1', candidate: 'Alice', timestamp_iso: '2026-09-01T10:00:00Z', status: 'Fail' },
        { history_id: 'rec-2', candidate: 'Alice', timestamp_iso: '2026-09-05T10:00:00Z', status: 'Pass' },
        { history_id: 'rec-3', candidate: 'Bob', timestamp_iso: '2026-09-03T10:00:00Z', status: 'Fail' },
      ];
      const map = getCandidateLatestSessionMap(history);
      expect(map.get('alice').history_id).toBe('rec-2');
      expect(map.get('bob').history_id).toBe('rec-3');
    });

    it('identifies superseded older records', () => {
      const rec1 = { history_id: 'rec-1', candidate: 'Alice', timestamp_iso: '2026-09-01T10:00:00Z', status: 'Fail' };
      const rec2 = { history_id: 'rec-2', candidate: 'Alice', timestamp_iso: '2026-09-05T10:00:00Z', status: 'Pass' };
      const history = [rec1, rec2];

      expect(isRecordSuperseded(rec1, history)).toBe(true);
      expect(isRecordSuperseded(rec2, history)).toBe(false);
    });
  });

  describe('canHistoryStartSession', () => {
    it('returns true for synced latest Fail record', () => {
      const rec = { history_id: 'rec-1', candidate: 'Frank', status: 'Fail', sync_status: 'synced' };
      expect(canHistoryStartSession(rec, [rec])).toBe(true);
    });

    it('returns false for local_only record', () => {
      const rec = { history_id: 'rec-1', candidate: 'Frank', status: 'Fail', sync_status: 'local_only' };
      expect(canHistoryStartSession(rec, [rec])).toBe(false);
    });

    it('returns false for superseded Fail record (older than newer session)', () => {
      const rec1 = { history_id: 'rec-1', candidate: 'Frank', timestamp_iso: '2026-09-01T10:00:00Z', status: 'Fail', sync_status: 'synced' };
      const rec2 = { history_id: 'rec-2', candidate: 'Frank', timestamp_iso: '2026-09-05T10:00:00Z', status: 'Fail', sync_status: 'synced' };
      expect(canHistoryStartSession(rec1, [rec1, rec2])).toBe(false);
      expect(canHistoryStartSession(rec2, [rec1, rec2])).toBe(true);
    });

    it('returns false if candidate subsequently passed', () => {
      const rec1 = { history_id: 'rec-1', candidate: 'Frank', timestamp_iso: '2026-09-01T10:00:00Z', status: 'Fail', sync_status: 'synced' };
      const rec2 = { history_id: 'rec-2', candidate: 'Frank', timestamp_iso: '2026-09-05T10:00:00Z', status: 'Pass', sync_status: 'synced' };
      expect(canHistoryStartSession(rec1, [rec1, rec2])).toBe(false);
      expect(canHistoryStartSession(rec2, [rec1, rec2])).toBe(false);
    });

    it('returns false if record is final attempt', () => {
      const rec = { history_id: 'rec-1', candidate: 'Frank', status: 'Fail', final_attempt: true, sync_status: 'synced' };
      expect(canHistoryStartSession(rec, [rec])).toBe(false);
    });

    it('returns false for non-Fail statuses', () => {
      expect(canHistoryStartSession({ candidate: 'Frank', status: 'Pass', sync_status: 'synced' }, [])).toBe(false);
      expect(canHistoryStartSession({ candidate: 'Frank', status: 'Incomplete', sync_status: 'synced' }, [])).toBe(false);
      expect(canHistoryStartSession({ candidate: 'Frank', status: 'NC/NS', sync_status: 'synced' }, [])).toBe(false);
    });
  });

  describe('canHistorySupervisorTransferOnly', () => {
    it('returns true for synced Incomplete record with pending newbie shift request', () => {
      const rec = {
        history_id: 'rec-1',
        candidate: 'Grace',
        status: 'Incomplete',
        newbie_shift_request_status: 'pending',
        sync_status: 'synced',
      };
      expect(canHistorySupervisorTransferOnly(rec, [rec])).toBe(true);
    });

    it('returns false for local_only record', () => {
      const rec = {
        history_id: 'rec-1',
        candidate: 'Grace',
        status: 'Incomplete',
        newbie_shift_request_status: 'pending',
        sync_status: 'local_only',
      };
      expect(canHistorySupervisorTransferOnly(rec, [rec])).toBe(false);
    });

    it('returns false when request status is approved or denied', () => {
      const recApproved = {
        history_id: 'rec-1',
        candidate: 'Grace',
        status: 'Incomplete',
        newbie_shift_request_status: 'approved',
        sync_status: 'synced',
      };
      const recDenied = {
        history_id: 'rec-2',
        candidate: 'Grace',
        status: 'Incomplete',
        newbie_shift_request_status: 'denied',
        sync_status: 'synced',
      };
      expect(canHistorySupervisorTransferOnly(recApproved, [recApproved])).toBe(false);
      expect(canHistorySupervisorTransferOnly(recDenied, [recDenied])).toBe(false);
    });

    it('returns false when supervisor transfer was already completed', () => {
      const rec = {
        history_id: 'rec-1',
        candidate: 'Grace',
        status: 'Incomplete',
        newbie_shift_request_status: 'pending',
        supervisor_transfer_completed: true,
        sync_status: 'synced',
      };
      expect(canHistorySupervisorTransferOnly(rec, [rec])).toBe(false);
    });

    it('returns false for superseded Incomplete record', () => {
      const rec1 = {
        history_id: 'rec-1',
        candidate: 'Grace',
        timestamp_iso: '2026-09-01T10:00:00Z',
        status: 'Incomplete',
        newbie_shift_request_status: 'pending',
        sync_status: 'synced',
      };
      const rec2 = {
        history_id: 'rec-2',
        candidate: 'Grace',
        timestamp_iso: '2026-09-05T10:00:00Z',
        status: 'Pass',
        sync_status: 'synced',
      };
      expect(canHistorySupervisorTransferOnly(rec1, [rec1, rec2])).toBe(false);
    });
  });
});
