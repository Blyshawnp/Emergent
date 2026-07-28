import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ModalProvider, useModal } from './ModalProvider';

jest.mock('../utils/sound', () => ({ playSound: jest.fn() }));

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function ModalProbe({ onReady }) {
  const modal = useModal();
  React.useEffect(() => onReady(modal), [modal, onReady]);
  return <button data-testid="research-trigger">Research Headset</button>;
}

async function renderProvider() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let modalApi;
  await act(async () => {
    root.render(
      <ModalProvider>
        <ModalProbe onReady={(api) => { modalApi = api; }} />
      </ModalProvider>
    );
    await flushPromises();
  });
  return {
    container,
    getModalApi: () => modalApi,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('repeated headset decision cycles keep one owned overlay and restore trigger focus', async () => {
  const view = await renderProvider();
  const trigger = view.container.querySelector('[data-testid="research-trigger"]');
  trigger.focus();

  for (let cycle = 0; cycle < 2; cycle += 1) {
    let result;
    await act(async () => {
      const pending = view.getModalApi().confirm('Another Headset?', 'Does the candidate have another headset?');
      pending.then((value) => { result = value; });
      await flushPromises();
    });

    expect(view.container.querySelectorAll('.cmodal-overlay.open')).toHaveLength(1);
    expect(view.container.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
    const noButton = view.container.querySelector('[data-testid="modal-btn-0"]');
    const yesButton = view.container.querySelector('[data-testid="modal-btn-1"]');
    expect(noButton.textContent).toBe('No');
    expect(yesButton.textContent).toBe('Yes');
    expect(document.activeElement).toBe(noButton);

    yesButton.focus();
    await act(async () => {
      yesButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      await flushPromises();
    });
    expect(document.activeElement).toBe(noButton);

    await act(async () => {
      noButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushPromises();
    });
    expect(result).toBe(false);
    expect(view.container.querySelectorAll('.cmodal-overlay.open')).toHaveLength(0);
    expect(document.activeElement).toBe(trigger);
  }

  await view.unmount();
});

test('a replacement decision reuses the shared overlay instead of stacking a second modal', async () => {
  const view = await renderProvider();

  await act(async () => {
    view.getModalApi().showModal({
      title: 'Headset Result',
      body: 'Research complete.',
      buttons: [{ label: 'Continue', cls: 'btn-primary', value: true }],
    });
    view.getModalApi().showModal({
      title: 'Another Headset?',
      body: 'Does the candidate have another headset?',
      buttons: [
        { label: 'No', cls: 'btn-muted', value: false },
        { label: 'Yes', cls: 'btn-primary', value: true },
      ],
    });
    await flushPromises();
  });

  expect(view.container.querySelectorAll('.cmodal-overlay.open')).toHaveLength(1);
  expect(view.container.querySelector('[role="dialog"]').getAttribute('aria-label')).toBe('Another Headset?');
  expect(view.container.textContent).not.toContain('Research complete.');

  await act(async () => {
    view.container.querySelector('[data-testid="modal-btn-0"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
  });

  await view.unmount();
});

test('success confirmation uses an affirmative icon, accessible dialog, and one completion action', async () => {
  const view = await renderProvider();
  await act(async () => {
    view.getModalApi().success('Request Submitted', 'The request is awaiting review.');
    await flushPromises();
  });
  const dialog = view.container.querySelector('[role="dialog"]');
  expect(dialog.classList.contains('cmodal-success')).toBe(true);
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(view.container.querySelector('.cmodal-icon i').getAttribute('data-lucide')).toBe('check-circle');
  expect(view.container.querySelectorAll('[data-testid^="modal-btn-"]')).toHaveLength(1);
  expect(view.container.querySelector('[data-testid="modal-btn-0"]').textContent).toBe('Done');
  await view.unmount();
});
