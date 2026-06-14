import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import SetupPage from './SetupPage';
import api from '../api';
import { playSound } from '../utils/sound';

const mockModal = {
  warning: jest.fn(),
  error: jest.fn(),
};

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    completeSetup: jest.fn(),
  },
}));

jest.mock('../components/ModalProvider', () => ({
  useModal: () => mockModal,
}));

jest.mock('../utils/sound', () => ({
  playSound: jest.fn(),
}));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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
  mockModal.warning.mockResolvedValue(true);
  mockModal.error.mockResolvedValue(true);
  api.completeSetup.mockResolvedValue({ ok: true });
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('setup uses default welcome audio and allows blank display name', async () => {
  const onSetupCompleted = jest.fn();
  const view = await renderComponent(<SetupPage onNavigate={jest.fn()} onSetupCompleted={onSetupCompleted} />);

  expect(playSound).toHaveBeenCalledWith('welcome', { setupComplete: false });
  expect(view.container.textContent).toContain('If blank, the app uses the first name from Tester Name.');

  await act(async () => {
    const first = view.container.querySelector('[data-testid="setup-first"]');
    setInputValue(first, 'Shawn');
    const last = view.container.querySelector('[data-testid="setup-last"]');
    setInputValue(last, 'Bly');
    view.container.querySelector('[data-testid="setup-next"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="setup-next"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="setup-next"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.completeSetup).toHaveBeenCalledWith(expect.objectContaining({
    tester_name: 'Shawn Bly',
    display_name: '',
  }));
  expect(onSetupCompleted).toHaveBeenCalled();

  await view.unmount();
});
