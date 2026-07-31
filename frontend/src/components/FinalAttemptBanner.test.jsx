import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import FinalAttemptBanner from './FinalAttemptBanner';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function renderBanner(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<FinalAttemptBanner {...props} />));
  return { container, root };
}

test('shows the canonical fourth final attempt as 4 of 4', async () => {
  const view = await renderBanner({ visible: true, attemptState: { current_attempt: 4, max_attempts: 4 } });
  expect(view.container.textContent).toContain('FINAL ATTEMPT');
  expect(view.container.textContent).toContain('Attempt 4 of 4');
  await act(async () => view.root.unmount());
  view.container.remove();
});

test('does not claim that attempt 2 of 4 is final', async () => {
  const view = await renderBanner({ visible: true, attemptState: { current_attempt: 2, max_attempts: 4 } });
  expect(view.container.textContent).not.toContain('FINAL ATTEMPT');
  expect(view.container.textContent).toContain('Attempt 2 of 4');
  expect(view.container.querySelector('[data-testid="attempt-consistency-warning"]')).not.toBeNull();
  await act(async () => view.root.unmount());
  view.container.remove();
});
