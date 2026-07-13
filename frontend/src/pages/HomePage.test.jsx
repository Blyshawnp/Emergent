import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import HomePage from './HomePage';

const mockModal = {
  showModal: jest.fn(),
  warning: jest.fn(),
  confirm: jest.fn(),
  alert: jest.fn(),
};

jest.mock('../components/ModalProvider', () => ({
  useModal: () => mockModal,
}));

jest.mock('../utils/sound', () => ({
  playSound: jest.fn(),
}));

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    getSettings: jest.fn(),
    getHistory: jest.fn(),
    getStats: jest.fn(),
    getSharedPendingSupTransfers: jest.fn(),
    startSession: jest.fn(),
  },
}));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderComponent(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(element);
    await flushPromises();
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockModal.showModal.mockResolvedValue('cancel');
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('supervisor transfer only modal makes Smart Resume the primary safe action', async () => {
  const view = await renderComponent(
    <HomePage
      onNavigate={jest.fn()}
      settings={{ tester_name: 'Tester One' }}
      history={[]}
      historyStats={{}}
      startupStatuses={{}}
      onHistoryRefresh={jest.fn().mockResolvedValue({ history: [], stats: {} })}
    />
  );

  await act(async () => {
    view.container.querySelector('[data-testid="home-sup-only-btn"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(mockModal.showModal).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Supervisor Transfer Only',
    body: expect.stringContaining('Use Smart Resume when this candidate has saved mock-call data'),
    buttons: [
      { label: 'Cancel', cls: 'btn-ghost', value: 'cancel' },
      { label: 'Start Supervisor Transfer Only', cls: 'btn-muted', value: 'standalone' },
      { label: 'Use Smart Resume', cls: 'btn-primary', value: 'smart-resume' },
    ],
  }));

  await view.unmount();
});

test('quick actions use five desktop columns and avoid a four plus one wrap', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'polish-mts.css'), 'utf8');
  expect(css).toContain('grid-template-columns: repeat(5, minmax(150px, 1fr))');
  expect(css).toContain('@media (max-width: 1120px)');
  expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
  expect(css).not.toContain('grid-template-columns: repeat(auto-fit, minmax(190px, 1fr))');
});
