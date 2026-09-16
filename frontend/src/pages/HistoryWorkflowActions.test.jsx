import React from 'react';
import fs from 'fs';
import path from 'path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import HistoryPage from './HistoryPage';
import ActiveCandidateHeader from '../components/ActiveCandidateHeader';
import api from '../api';

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockModal = {
  alert: jest.fn(),
  success: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
  confirm: jest.fn(),
  confirmDanger: jest.fn(),
  showModal: jest.fn(),
};

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getHistory: jest.fn(),
    getHistoryStats: jest.fn(),
    reconcileHistory: jest.fn(),
    startSession: jest.fn(),
    fillForm: jest.fn(),
    deleteHistorySession: jest.fn(),
    requestHistorySessionDeletion: jest.fn(),
    requestHistorySessionCorrection: jest.fn(),
    updateHistorySessionFormStatus: jest.fn(),
    retryHistorySessionSync: jest.fn(),
    logHeadsetReview: jest.fn(),
    clearHistory: jest.fn(),
    getSharedPendingSupTransfers: jest.fn(),
  },
}));

jest.mock('../components/ModalProvider', () => ({
  useModal: () => mockModal,
}));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderHistoryPage(history, options = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onNavigate = jest.fn();

  api.getHistory.mockResolvedValue(history);
  api.getHistoryStats.mockResolvedValue({
    total: history.length,
    passes: 0,
    fails: 0,
    ncns: 0,
    incomplete: 0,
    pass_rate: 0,
  });
  api.reconcileHistory.mockResolvedValue({
    ok: true,
    history,
    stats: { total: history.length },
  });

  const settings = options.settings || { tester_name: 'Current Tester', display_name: 'Current Tester' };

  await act(async () => {
    root.render(
      <HistoryPage
        onNavigate={onNavigate}
        history={history}
        historyStats={{ total: history.length }}
        settings={settings}
      />
    );
    await flushPromises();
  });

  return {
    container,
    onNavigate,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('ActiveCandidateHeader component', () => {
  it('renders .candidate-header and .candidate-header-label with candidate name', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(<ActiveCandidateHeader candidateName="John Doe" />);
    });
    const header = container.querySelector('.candidate-header');
    expect(header).not.toBeNull();
    expect(header.textContent).toContain('Candidate:');
    expect(header.textContent).toContain('John Doe');
    expect(container.querySelector('.candidate-header-label')).not.toBeNull();
    act(() => { root.unmount(); });
  });

  it('renders null when candidateName is missing or whitespace only', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(<ActiveCandidateHeader candidateName="   " />);
    });
    expect(container.querySelector('.candidate-header')).toBeNull();
    act(() => { root.unmount(); });
  });

  it('applies custom className when provided', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(<ActiveCandidateHeader candidateName="Jane Doe" className="custom-test-class" />);
    });
    const header = container.querySelector('.candidate-header.custom-test-class');
    expect(header).not.toBeNull();
    act(() => { root.unmount(); });
  });
});

describe('History action priority and workflows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockModal.confirm.mockResolvedValue(true);
    api.startSession.mockResolvedValue({ ok: true, session: {} });
  });

  it('local_only record shows Retry Hosted Sync and neither Start Session nor Supervisor Transfer Only', async () => {
    const history = [
      {
        history_id: 'rec-local-fail',
        candidate_name: 'Local Candidate',
        tester_name: 'Tester One',
        status: 'Fail',
        sync_status: 'local_only',
        timestamp_iso: '2026-09-10T10:00:00Z',
      },
    ];
    const { container, unmount } = await renderHistoryPage(history);

    expect(container.querySelector('[data-testid="history-retry-sync-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="history-start-session-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="history-sup-transfer-only-0"]')).toBeNull();

    await unmount();
  });

  it('synced Fail record shows Start Session and does not show Supervisor Transfer Only', async () => {
    const history = [
      {
        history_id: 'rec-synced-fail',
        candidate_name: 'Failed Candidate',
        tester_name: 'Tester One',
        status: 'Fail',
        sync_status: 'synced',
        timestamp_iso: '2026-09-10T10:00:00Z',
      },
    ];
    const { container, unmount } = await renderHistoryPage(history);

    expect(container.querySelector('[data-testid="history-start-session-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="history-sup-transfer-only-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="history-retry-sync-0"]')).toBeNull();

    await unmount();
  });

  it('synced Incomplete record with pending newbie shift request shows Supervisor Transfer Only', async () => {
    const history = [
      {
        history_id: 'rec-synced-inc',
        candidate_name: 'Incomplete Candidate',
        tester_name: 'Tester One',
        status: 'Incomplete',
        newbie_shift_request_status: 'pending',
        sync_status: 'synced',
        timestamp_iso: '2026-09-10T10:00:00Z',
      },
    ];
    const { container, unmount } = await renderHistoryPage(history);

    expect(container.querySelector('[data-testid="history-sup-transfer-only-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="history-start-session-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="history-retry-sync-0"]')).toBeNull();

    await unmount();
  });

  it('Pass and final attempt records show neither Start Session nor Supervisor Transfer Only', async () => {
    const history = [
      {
        history_id: 'rec-pass',
        candidate_name: 'Passed Candidate',
        tester_name: 'Tester One',
        status: 'Pass',
        sync_status: 'synced',
        timestamp_iso: '2026-09-10T10:00:00Z',
      },
      {
        history_id: 'rec-final-fail',
        candidate_name: 'Terminal Candidate',
        tester_name: 'Tester One',
        status: 'Fail',
        final_attempt: true,
        sync_status: 'synced',
        timestamp_iso: '2026-09-11T10:00:00Z',
      },
    ];
    const { container, unmount } = await renderHistoryPage(history);

    expect(container.querySelector('[data-testid="history-start-session-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="history-sup-transfer-only-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="history-start-session-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="history-sup-transfer-only-1"]')).toBeNull();

    await unmount();
  });

  // Case A: Older Fail followed by newer Pass
  it('Case A: Older Fail followed by newer Pass does NOT offer Start Session on stale Fail row', async () => {
    const history = [
      {
        history_id: 'session-pass',
        candidate_name: 'Alex Johnson',
        tester_name: 'Tester One',
        status: 'Pass',
        sync_status: 'synced',
        timestamp_iso: '2026-09-15T12:00:00Z',
        timestamp: '09/15/2026 12:00 PM',
      },
      {
        history_id: 'session-fail',
        candidate_name: 'Alex Johnson',
        tester_name: 'Tester One',
        status: 'Fail',
        sync_status: 'synced',
        timestamp_iso: '2026-09-10T10:00:00Z',
        timestamp: '09/10/2026 10:00 AM',
      },
    ];
    const { container, unmount } = await renderHistoryPage(history);

    // Row 0 is the newer Pass session
    expect(container.querySelector('[data-testid="history-start-session-0"]')).toBeNull();
    // Row 1 is the older Fail session - must NOT offer Start Session
    expect(container.querySelector('[data-testid="history-start-session-1"]')).toBeNull();

    await unmount();
  });

  // Case B: Older Fail followed by newer Fail
  it('Case B: Older Fail followed by newer Fail offers retry only on latest canonical state', async () => {
    const history = [
      {
        history_id: 'session-fail-2',
        candidate_name: 'Alex Johnson',
        tester_name: 'Tester One',
        status: 'Fail',
        attempt_number: 2,
        sync_status: 'synced',
        timestamp_iso: '2026-09-15T12:00:00Z',
        timestamp: '09/15/2026 12:00 PM',
      },
      {
        history_id: 'session-fail-1',
        candidate_name: 'Alex Johnson',
        tester_name: 'Tester One',
        status: 'Fail',
        attempt_number: 1,
        sync_status: 'synced',
        timestamp_iso: '2026-09-10T10:00:00Z',
        timestamp: '09/10/2026 10:00 AM',
      },
    ];
    const { container, onNavigate, unmount } = await renderHistoryPage(history);

    // Row 1 (older Fail) is superseded and must not offer Start Session
    expect(container.querySelector('[data-testid="history-start-session-1"]')).toBeNull();

    // Row 0 (latest Fail) offers Start Session
    const startBtn = container.querySelector('[data-testid="history-start-session-0"]');
    expect(startBtn).not.toBeNull();

    // Click Start Session on latest
    await act(async () => {
      startBtn.click();
      await flushPromises();
    });

    expect(mockModal.confirm).toHaveBeenCalled();
    expect(api.startSession).toHaveBeenCalled();
    const savedSession = api.startSession.mock.calls[0][0];
    expect(savedSession.attempt_number).toBe(3);
    expect(savedSession.candidate_name).toBe('Alex Johnson');
    expect(onNavigate).toHaveBeenCalledWith('basics', { session: savedSession });

    await unmount();
  });

  // Case C: Pending Newbie Shift shown in History, remotely approved before click
  it('Case C: Pending Newbie Shift remotely approved before click blocks launch with warning', async () => {
    const history = [
      {
        history_id: 'session-inc-1',
        candidate_name: 'Jordan Lee',
        tester_name: 'Tester One',
        status: 'Incomplete',
        newbie_shift_request_id: 'req-ns-1',
        newbie_shift_request_status: 'pending',
        sync_status: 'synced',
        timestamp_iso: '2026-09-12T10:00:00Z',
      },
    ];

    // Canonical check returns empty or approved status
    api.getSharedPendingSupTransfers.mockResolvedValue({
      ok: true,
      items: [
        {
          candidate_name: 'Jordan Lee',
          request_id: 'req-ns-1',
          status: 'approved',
        },
      ],
    });

    const { container, onNavigate, unmount } = await renderHistoryPage(history);

    const supBtn = container.querySelector('[data-testid="history-sup-transfer-only-0"]');
    expect(supBtn).not.toBeNull();

    await act(async () => {
      supBtn.click();
      await flushPromises();
    });

    expect(api.getSharedPendingSupTransfers).toHaveBeenCalled();
    expect(mockModal.warning).toHaveBeenCalledWith(
      'Supervisor Transfer Unavailable',
      expect.stringContaining('already been completed, resolved, or is no longer pending')
    );
    expect(api.startSession).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();

    await unmount();
  });

  // Case D: Pending Newbie Shift shown in History, remotely denied before click
  it('Case D: Pending Newbie Shift remotely denied before click blocks launch with warning', async () => {
    const history = [
      {
        history_id: 'session-inc-1',
        candidate_name: 'Jordan Lee',
        tester_name: 'Tester One',
        status: 'Incomplete',
        newbie_shift_request_id: 'req-ns-1',
        newbie_shift_request_status: 'pending',
        sync_status: 'synced',
        timestamp_iso: '2026-09-12T10:00:00Z',
      },
    ];

    api.getSharedPendingSupTransfers.mockResolvedValue({
      ok: true,
      items: [
        {
          candidate_name: 'Jordan Lee',
          request_id: 'req-ns-1',
          status: 'denied',
        },
      ],
    });

    const { container, onNavigate, unmount } = await renderHistoryPage(history);

    const supBtn = container.querySelector('[data-testid="history-sup-transfer-only-0"]');
    expect(supBtn).not.toBeNull();

    await act(async () => {
      supBtn.click();
      await flushPromises();
    });

    expect(api.getSharedPendingSupTransfers).toHaveBeenCalled();
    expect(mockModal.warning).toHaveBeenCalledWith(
      'Supervisor Transfer Unavailable',
      expect.stringContaining('already been completed, resolved, or is no longer pending')
    );
    expect(api.startSession).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();

    await unmount();
  });

  // Case E: Pending Newbie Shift completed by another tester before click
  it('Case E: Pending Newbie Shift completed by another tester before click blocks launch', async () => {
    const history = [
      {
        history_id: 'session-inc-1',
        candidate_name: 'Jordan Lee',
        tester_name: 'Tester One',
        status: 'Incomplete',
        newbie_shift_request_id: 'req-ns-1',
        newbie_shift_request_status: 'pending',
        sync_status: 'synced',
        timestamp_iso: '2026-09-12T10:00:00Z',
      },
    ];

    // Request is no longer in pending transfers list
    api.getSharedPendingSupTransfers.mockResolvedValue({
      ok: true,
      items: [],
    });

    const { container, onNavigate, unmount } = await renderHistoryPage(history);

    const supBtn = container.querySelector('[data-testid="history-sup-transfer-only-0"]');
    expect(supBtn).not.toBeNull();

    await act(async () => {
      supBtn.click();
      await flushPromises();
    });

    expect(api.getSharedPendingSupTransfers).toHaveBeenCalled();
    expect(mockModal.warning).toHaveBeenCalledWith(
      'Supervisor Transfer Unavailable',
      expect.stringContaining('already been completed, resolved, or is no longer pending')
    );
    expect(api.startSession).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();

    await unmount();
  });

  // Case F: Different-tester failed-candidate Start Session
  it('Case F: Different-tester failed candidate starts normal certification workflow and preserves attribution', async () => {
    const history = [
      {
        history_id: 'session-fail-alice',
        candidate_name: 'Sam TesterCandidate',
        candidate_id: 'cand-777',
        tester_name: 'Alice Original',
        status: 'Fail',
        attempt_number: 1,
        prior_counted_attempts: 1,
        sync_status: 'synced',
        timestamp_iso: '2026-09-12T10:00:00Z',
        newbie_shift_request_id: 'old-stale-req',
        headset_brand: 'Jabra Evolve 65',
        headset_usb: true,
      },
    ];

    const { container, onNavigate, unmount } = await renderHistoryPage(history, {
      settings: { tester_name: 'Bob Current' },
    });

    const startBtn = container.querySelector('[data-testid="history-start-session-0"]');
    expect(startBtn).not.toBeNull();

    await act(async () => {
      startBtn.click();
      await flushPromises();
    });

    expect(mockModal.confirm).toHaveBeenCalled();
    expect(api.startSession).toHaveBeenCalled();
    const session = api.startSession.mock.calls[0][0];

    // Normal workflow: not supervisor-only
    expect(session.supervisor_only).toBe(false);
    expect(session.resumed_sup_transfer_only).toBe(false);

    // Attribution
    expect(session.candidate_name).toBe('Sam TesterCandidate');
    expect(session.tester_name).toBe('Bob Current');
    expect(session.resume_source_tester).toBe('Alice Original');
    expect(session.smart_resumed).toBe(true);

    // Next attempt
    expect(session.attempt_number).toBe(2);
    expect(session.prior_counted_attempts).toBe(1);

    // Zero stale newbie shift fields
    expect(session.newbie_shift_request_id).toBe('');

    // Routes to basics
    expect(onNavigate).toHaveBeenCalledWith('basics', { session });

    await unmount();
  });

  it('valid Supervisor Transfer Only preserves newbie_shift_request_id and routes to suptransfer', async () => {
    const history = [
      {
        history_id: 'session-inc-valid',
        candidate_name: 'Morgan Casey',
        tester_name: 'Alice Original',
        status: 'Incomplete',
        newbie_shift_request_id: 'req-keep-123',
        newbie_shift_request_status: 'pending',
        sync_status: 'synced',
        timestamp_iso: '2026-09-12T10:00:00Z',
        call_1: { result: 'Pass' },
        call_2: { result: 'Pass' },
      },
    ];

    api.getSharedPendingSupTransfers.mockResolvedValue({
      ok: true,
      items: [
        {
          candidate_name: 'Morgan Casey',
          newbie_shift_request_id: 'req-keep-123',
          original_session_id: 'session-inc-valid',
          status: 'pending',
        },
      ],
    });

    const { container, onNavigate, unmount } = await renderHistoryPage(history, {
      settings: { tester_name: 'Bob Supervisor' },
    });

    const supBtn = container.querySelector('[data-testid="history-sup-transfer-only-0"]');
    expect(supBtn).not.toBeNull();

    await act(async () => {
      supBtn.click();
      await flushPromises();
    });

    expect(api.getSharedPendingSupTransfers).toHaveBeenCalled();
    expect(mockModal.confirm).toHaveBeenCalled();
    expect(api.startSession).toHaveBeenCalled();

    const resumed = api.startSession.mock.calls[0][0];
    expect(resumed.supervisor_only).toBe(true);
    expect(resumed.resumed_sup_transfer_only).toBe(true);
    expect(resumed.newbie_shift_request_id).toBe('req-keep-123');
    expect(resumed.tester_name).toBe('Bob Supervisor');
    expect(resumed.resume_source_tester).toBe('Alice Original');
    expect(resumed.call_1).toEqual({ result: 'Pass' });
    expect(onNavigate).toHaveBeenCalledWith('suptransfer', { session: resumed });

    await unmount();
  });

  it('Detail modal renders Start Session for eligible Fail and executes retry', async () => {
    const history = [
      {
        history_id: 'session-detail-fail',
        candidate_name: 'Detail Candidate',
        tester_name: 'Alice Original',
        status: 'Fail',
        sync_status: 'synced',
        timestamp_iso: '2026-09-12T10:00:00Z',
      },
    ];

    const { container, onNavigate, unmount } = await renderHistoryPage(history, {
      settings: { tester_name: 'Bob Current' },
    });

    // Open detail modal
    const viewBtn = container.querySelector('[data-testid="history-view-0"]');
    await act(async () => {
      viewBtn.click();
      await flushPromises();
    });

    const modalStartBtn = container.querySelector('[data-testid="history-detail-start-session"]');
    expect(modalStartBtn).not.toBeNull();

    await act(async () => {
      modalStartBtn.click();
      await flushPromises();
    });

    expect(api.startSession).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith('basics', expect.any(Object));

    await unmount();
  });

  it('Detail modal renders Supervisor Transfer Only for eligible Incomplete and executes resume', async () => {
    const history = [
      {
        history_id: 'session-detail-inc',
        candidate_name: 'Detail Inc Candidate',
        tester_name: 'Alice Original',
        status: 'Incomplete',
        newbie_shift_request_id: 'req-det-1',
        newbie_shift_request_status: 'pending',
        sync_status: 'synced',
        timestamp_iso: '2026-09-12T10:00:00Z',
      },
    ];

    api.getSharedPendingSupTransfers.mockResolvedValue({
      ok: true,
      items: [
        {
          candidate_name: 'Detail Inc Candidate',
          newbie_shift_request_id: 'req-det-1',
          status: 'pending',
        },
      ],
    });

    const { container, onNavigate, unmount } = await renderHistoryPage(history, {
      settings: { tester_name: 'Bob Current' },
    });

    // Open detail modal
    const viewBtn = container.querySelector('[data-testid="history-view-0"]');
    await act(async () => {
      viewBtn.click();
      await flushPromises();
    });

    const modalSupBtn = container.querySelector('[data-testid="history-detail-sup-transfer-only"]');
    expect(modalSupBtn).not.toBeNull();

    await act(async () => {
      modalSupBtn.click();
      await flushPromises();
    });

    expect(api.getSharedPendingSupTransfers).toHaveBeenCalled();
    expect(api.startSession).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith('suptransfer', expect.any(Object));

    await unmount();
  });
});

// Case H: No circular imports
describe('Case H: Architectural separation and no circular page imports', () => {
  it('HistoryPage.jsx does not import HomePage', () => {
    const filePath = path.join(__dirname, 'HistoryPage.jsx');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).not.toMatch(/from\s+['"][^'"]*HomePage/);
  });

  it('HomePage.jsx does not import HistoryPage', () => {
    const filePath = path.join(__dirname, 'HomePage.jsx');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).not.toMatch(/from\s+['"][^'"]*HistoryPage/);
  });
});
