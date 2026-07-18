import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import PostSetupQuickStart from './PostSetupQuickStart';
import { TutorialVideoLibrary } from './TutorialVideoPlayer';
import { normalizeTutorialVideos } from '../utils/tutorialVideos';

beforeAll(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; });

async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, root };
}

afterEach(() => { document.body.innerHTML = ''; delete window.electronAPI; });

test('mounts only the selected iframe and opens the safe browser URL', async () => {
  const openExternal = jest.fn().mockResolvedValue(true);
  window.electronAPI = { openExternal };
  const videos = [
    { app: 'mts', category: 'Quick Start', videoKey: 'one', title: 'One', videoId: 'dQw4w9WgXcQ', youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ', active: true },
    { app: 'mts', category: 'Quick Start', videoKey: 'two', title: 'Two', videoId: '9bZkp7q19f0', youtubeUrl: 'https://youtu.be/9bZkp7q19f0', active: true },
  ];
  const view = await render(<TutorialVideoLibrary videos={videos} />);
  expect(view.container.querySelectorAll('iframe')).toHaveLength(0);

  await act(async () => view.container.querySelector('[aria-label="Play One tutorial"]').click());
  expect(view.container.querySelectorAll('iframe')).toHaveLength(1);
  expect(view.container.querySelector('iframe').src).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');

  await act(async () => view.container.querySelector('[aria-label="Play Two tutorial"]').click());
  expect(view.container.querySelectorAll('iframe')).toHaveLength(1);
  expect(view.container.querySelector('iframe').src).toContain('youtube-nocookie.com/embed/9bZkp7q19f0');

  await act(async () => view.container.querySelector('.tutorial-browser-row button').click());
  expect(openExternal).toHaveBeenCalledWith('https://www.youtube.com/watch?v=9bZkp7q19f0');
});

test('quick start offers all choices and Escape skips without forcing a tutorial', async () => {
  const onWatch = jest.fn();
  const onGuide = jest.fn();
  const onContinue = jest.fn();
  const view = await render(<PostSetupQuickStart app="sam" onWatch={onWatch} onGuide={onGuide} onContinue={onContinue} />);
  expect(view.container.textContent).toContain('Watch the SAM Quick Start');
  expect(view.container.textContent).toContain('Open the SAM User Guide');
  expect(view.container.textContent).toContain('Go to SAM Dashboard');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onWatch).not.toHaveBeenCalled();
});

test('empty and temporarily unavailable libraries preserve written Help guidance', async () => {
  const empty = await render(<TutorialVideoLibrary videos={[]} />);
  expect(empty.container.textContent).toContain('No tutorial videos have been added yet.');
  expect(empty.container.textContent).toContain('Written Help remains available.');
  await act(async () => empty.root.unmount());

  const retry = jest.fn();
  const unavailable = await render(<TutorialVideoLibrary videos={[]} loadError="offline" onRetry={retry} />);
  expect(unavailable.container.textContent).toContain('Tutorial videos are temporarily unavailable.');
  expect(unavailable.container.textContent).toContain('Written Help remains available.');
  await act(async () => unavailable.container.querySelector('button').click());
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => unavailable.root.unmount());
});

test('inactive rows are hidden and blank video URLs render a calm coming-soon card', async () => {
  const videos = normalizeTutorialVideos([
    { Category: 'Quick Start', VideoKey: 'active', Title: 'Active Tutorial', YouTubeURL: '', Active: 'TRUE' },
    { Category: 'Quick Start', VideoKey: 'inactive', Title: 'Inactive Tutorial', YouTubeURL: 'https://youtu.be/dQw4w9WgXcQ', Active: 'FALSE' },
  ], 'mts');
  const view = await render(<TutorialVideoLibrary videos={videos} />);

  expect(view.container.textContent).toContain('Active Tutorial');
  expect(view.container.textContent).toContain('Video Coming Soon');
  expect(view.container.textContent).not.toContain('Inactive Tutorial');
  expect(view.container.querySelector('iframe')).toBeNull();
  expect(view.container.querySelector('[aria-label="Play Active Tutorial tutorial"]')).toBeNull();
  await act(async () => view.root.unmount());
});
