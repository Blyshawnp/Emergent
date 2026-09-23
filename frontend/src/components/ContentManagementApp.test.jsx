import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ContentManagementApp from './ContentManagementApp';
import api from '../api';

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buttonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent.trim().toLowerCase().includes(text.toLowerCase())
  );
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ContentManagementApp', () => {
  let container;
  let root;

  const mockCallersState = {
    ok: true,
    draft_items: [
      {
        id: 'c1',
        category: 'New',
        first_name: 'Sam',
        last_name: 'Smith',
        city: 'Philadelphia',
        zip: '19130',
        phone: '215-515-1212',
        email: 'ssmith@test.com',
        is_active: true,
        updated_at: '2026-09-22T00:00:00Z',
      },
      {
        id: 'c2',
        category: 'Existing',
        first_name: 'Ron',
        last_name: 'Jones',
        city: 'Philadelphia',
        zip: '19104',
        phone: '215-555-1234',
        email: 'rjones@test.com',
        is_active: false,
        updated_at: '2026-09-22T00:00:00Z',
      },
    ],
    current_publication: {
      version_id: 'callers-v1',
      content_hash: '2380bd5e00e0fbe3',
      item_count: 22,
      published_at: '2026-09-22T00:00:00Z',
      published_by: 'Admin User',
    },
    version_history: [
      {
        version_id: 'callers-v1',
        content_hash: '2380bd5e00e0fbe3',
        item_count: 22,
        published_at: '2026-09-22T00:00:00Z',
        published_by: 'Admin User',
        notes: 'Initial publication',
        is_current: true,
      },
    ],
  };

  const mockDiscordState = {
    ok: true,
    draft_items: [
      {
        id: 'd1',
        category: 'Failure Outcomes',
        title: 'VPN Fail',
        message: 'Using a VPN is not accepted when contracting with ACD.',
        suggested_screenshots: [],
        display_order: 1,
        is_active: true,
        updated_at: '2026-09-22T00:00:00Z',
      },
    ],
    current_publication: {
      version_id: 'discord_posts-v1',
      content_hash: '16692438053d101c',
      item_count: 28,
      published_at: '2026-09-22T00:00:00Z',
      published_by: 'Admin User',
    },
    version_history: [
      {
        version_id: 'discord_posts-v1',
        content_hash: '16692438053d101c',
        item_count: 28,
        published_at: '2026-09-22T00:00:00Z',
        published_by: 'Admin User',
        notes: 'Initial discord publication',
        is_current: true,
      },
    ],
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    jest.spyOn(api, 'getContentManagementState').mockImplementation((domain) => {
      if (domain === 'discord_posts') return Promise.resolve(mockDiscordState);
      return Promise.resolve(mockCallersState);
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  async function renderApp(accessToken = 'valid-test-token') {
    await act(async () => {
      root.render(<ContentManagementApp accessToken={accessToken} />);
      await flushPromises();
    });
  }

  test('renders Callers and Discord Posts sub-tabs', async () => {
    await renderApp();
    const callerTab = buttonByText(container, 'Caller Roster');
    const discordTab = buttonByText(container, 'Discord Posts');
    expect(callerTab).toBeTruthy();
    expect(discordTab).toBeTruthy();
    expect(container.textContent).toContain('Sam');
    expect(container.textContent).toContain('Smith');
  });

  test('switches domains when tabs are clicked', async () => {
    await renderApp();
    const discordTab = buttonByText(container, 'Discord Posts');
    await act(async () => {
      discordTab.click();
      await flushPromises();
    });
    expect(api.getContentManagementState).toHaveBeenCalledWith('discord_posts', 'valid-test-token');
    expect(container.textContent).toContain('VPN Fail');
  });

  test('editing an item displays edit form with item values', async () => {
    await renderApp();
    const editBtn = buttonByText(container, 'Edit');
    expect(editBtn).toBeTruthy();

    await act(async () => {
      editBtn.click();
      await flushPromises();
    });

    const inputs = container.querySelectorAll('.cm-input');
    expect(inputs.length).toBeGreaterThan(0);
    const saveBtn = buttonByText(container, 'Save');
    expect(saveBtn).toBeTruthy();
  });

  test('concurrent edit error displays conflict message', async () => {
    jest.spyOn(api, 'saveContentManagementItem').mockResolvedValueOnce({
      ok: false,
      error_code: 'CONCURRENT_EDIT',
      error: 'This item was modified by another editor.',
    });

    await renderApp();
    const editBtn = buttonByText(container, 'Edit');
    await act(async () => {
      editBtn.click();
      await flushPromises();
    });

    const saveBtn = buttonByText(container, 'Save');
    await act(async () => {
      saveBtn.click();
      await flushPromises();
    });

    expect(container.textContent).toContain('modified this item');
  });

  test('publish confirmation modal shows item count', async () => {
    await renderApp();
    const publishBtn = buttonByText(container, 'Publish');
    expect(publishBtn).toBeTruthy();

    await act(async () => {
      publishBtn.click();
      await flushPromises();
    });

    expect(container.textContent).toContain('Confirm Publish');
    expect(container.textContent).toContain('active item(s)');
  });

  test('publish unchanged content shows informative message', async () => {
    jest.spyOn(api, 'publishContentManagementDomain').mockResolvedValueOnce({
      ok: false,
      error_code: 'CONTENT_UNCHANGED',
      error: 'No changes to publish.',
    });

    await renderApp();
    const publishBtn = buttonByText(container, 'Publish');
    await act(async () => {
      publishBtn.click();
      await flushPromises();
    });

    const confirmBtn = buttonByText(container, 'Confirm Publish');
    await act(async () => {
      confirmBtn.click();
      await flushPromises();
    });

    expect(container.textContent).toContain('No changes to publish');
  });

  test('version history panel shows past versions', async () => {
    await renderApp();
    const historyBtn = buttonByText(container, 'Version History');
    expect(historyBtn).toBeTruthy();

    await act(async () => {
      historyBtn.click();
      await flushPromises();
    });

    expect(container.textContent).toContain('callers-v1');
    expect(container.textContent).toContain('Initial publication');
  });

  test('restore with "Also replace draft" unchecked warns before replacing', async () => {
    const historyWithPast = {
      ...mockCallersState,
      version_history: [
        {
          version_id: 'callers-v2',
          content_hash: 'hash-v2',
          item_count: 22,
          published_at: '2026-09-22T01:00:00Z',
          published_by: 'Admin User',
          is_current: true,
        },
        {
          version_id: 'callers-v1',
          content_hash: '2380bd5e00e0fbe3',
          item_count: 22,
          published_at: '2026-09-22T00:00:00Z',
          published_by: 'Admin User',
          is_current: false,
        },
      ],
    };
    jest.spyOn(api, 'getContentManagementState').mockResolvedValue(historyWithPast);

    await renderApp();
    const historyBtn = buttonByText(container, 'Version History');
    await act(async () => {
      historyBtn.click();
      await flushPromises();
    });

    const restoreBtn = buttonByText(container, 'Restore');
    expect(restoreBtn).toBeTruthy();

    await act(async () => {
      restoreBtn.click();
      await flushPromises();
    });

    expect(container.textContent).toContain('Restore Publication?');
    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox.checked).toBe(false);

    // Clicking checkbox displays warning
    await act(async () => {
      checkbox.click();
      await flushPromises();
    });
    expect(container.textContent).toContain('This will replace your current unpublished draft edits');
  });
});
