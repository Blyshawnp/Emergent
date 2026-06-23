import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import TechIssueDialog from './TechIssueDialog';
import api from '../api';

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getCurrentSession: jest.fn(),
    updateSession: jest.fn(),
    startSession: jest.fn(),
  },
}));

jest.mock('../utils/sound', () => ({ playSound: jest.fn() }));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  api.getCurrentSession.mockResolvedValue({ session: { candidate_name: 'Taylor Example', tech_issues_log: [] } });
  api.updateSession.mockResolvedValue({ ok: true });
  api.startSession.mockResolvedValue({ ok: true });
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function renderDialog() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = jest.fn();
  const onNavigate = jest.fn();
  await act(async () => {
    root.render(<TechIssueDialog open onClose={onClose} isFinalAttempt={false} onNavigate={onNavigate} context="calls" />);
    await flushPromises();
  });
  return { container, onClose, onNavigate, unmount: async () => act(async () => root.unmount()) };
}

function click(element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

test('renders all required technical issue categories', async () => {
  const view = await renderDialog();
  expect(view.container.textContent).toContain('Internet Speed Issues');
  expect(view.container.textContent).toContain('Calls Would Not Route');
  expect(view.container.textContent).toContain('No Script Pop');
  expect(view.container.textContent).toContain('Discord Issues');
  expect(view.container.textContent).toContain('Other');
  await view.unmount();
});

test('Discord troubleshooting can end the session with summary markers and route to Review', async () => {
  const view = await renderDialog();
  await act(async () => click(view.container.querySelector('[data-testid="tech-issue-discord"] input')));
  await act(async () => click(view.container.querySelector('[data-testid="tech-issue-continue"]')));
  expect(view.container.textContent).toContain('Discord Troubleshooting');

  await act(async () => click(view.container.querySelector('[data-testid="discord-steps-done"]')));
  await act(async () => {
    click(view.container.querySelector('[data-testid="browser-result-no"]'));
    await flushPromises();
  });
  expect(view.container.textContent).toContain('Were you able to complete the session despite the issues?');

  await act(async () => {
    click(view.container.querySelector('[data-testid="complete-no"]'));
    await flushPromises();
  });
  expect(api.startSession).toHaveBeenCalledWith(expect.objectContaining({
    tech_issue: 'Discord issues - unresolved',
    tech_issue_ended_session: true,
    tech_issue_summary_required: true,
    final_status: 'Fail',
  }));
  expect(view.onNavigate).toHaveBeenCalledWith('review', expect.any(Object));
  await view.unmount();
});

test('Other requires a description before resolution can be recorded', async () => {
  const view = await renderDialog();
  await act(async () => click(view.container.querySelector('[data-testid="tech-issue-other"] input')));
  await act(async () => click(view.container.querySelector('[data-testid="tech-issue-continue"]')));
  expect(view.container.querySelector('[data-testid="other-not-resolved"]').disabled).toBe(true);
  expect(view.container.querySelector('[data-testid="other-resolved"]').disabled).toBe(true);
  await view.unmount();
});
