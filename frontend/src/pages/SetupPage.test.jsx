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

function setSelectValue(select, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
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
    ticker_speed: 'normal',
    welcome_voice: 'male',
    sound_volume: 'medium',
    enable_sounds: true,
  }));
  expect(onSetupCompleted).toHaveBeenCalled();

  await view.unmount();
});

test('setup shows and saves ticker speed, welcome voice, and sound volume', async () => {
  const onSetupCompleted = jest.fn();
  const view = await renderComponent(<SetupPage onNavigate={jest.fn()} onSetupCompleted={onSetupCompleted} />);

  await act(async () => {
    setInputValue(view.container.querySelector('[data-testid="setup-first"]'), 'Debra');
    setInputValue(view.container.querySelector('[data-testid="setup-last"]'), 'Smith');
    setInputValue(view.container.querySelector('[data-testid="setup-display"]'), 'Debbie');
    view.container.querySelector('[data-testid="setup-next"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await act(async () => {
    view.container.querySelector('[data-testid="setup-next"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(view.container.querySelector('[data-testid="setup-ticker-speed"]').value).toBe('normal');
  expect(view.container.querySelector('[data-testid="setup-welcome-voice"]').value).toBe('male');
  expect(view.container.querySelector('[data-testid="setup-sound-volume"]').value).toBe('medium');

  await act(async () => {
    setSelectValue(view.container.querySelector('[data-testid="setup-ticker-speed"]'), 'fast');
    setSelectValue(view.container.querySelector('[data-testid="setup-welcome-voice"]'), 'female');
    setSelectValue(view.container.querySelector('[data-testid="setup-sound-volume"]'), 'low');
    view.container.querySelector('[data-testid="setup-next"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  expect(api.completeSetup).toHaveBeenCalledWith(expect.objectContaining({
    tester_name: 'Debra Smith',
    display_name: 'Debbie',
    ticker_speed: 'fast',
    welcome_voice: 'female',
    sound_volume: 'low',
    enable_sounds: true,
  }));

  await view.unmount();
});
