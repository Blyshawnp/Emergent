import {
  buildYouTubeEmbedUrl,
  extractYouTubeVideoId,
  normalizeTutorialVideos,
} from './tutorialVideos';

const ID = 'dQw4w9WgXcQ';

test.each([
  [ID, ID],
  [`https://www.youtube.com/watch?v=${ID}`, ID],
  [`https://youtu.be/${ID}`, ID],
  [`https://www.youtube.com/embed/${ID}`, ID],
  [`https://www.youtube-nocookie.com/embed/${ID}`, ID],
])('accepts supported YouTube value %s', (value, expected) => {
  expect(extractYouTubeVideoId(value)).toBe(expected);
  expect(buildYouTubeEmbedUrl(value)).toBe(`https://www.youtube-nocookie.com/embed/${ID}?rel=0`);
});

test.each([
  '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
  'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtube.example/watch?v=dQw4w9WgXcQ',
  'https://example.com/dQw4w9WgXcQ',
  'too-short',
])('rejects unsafe or invalid video value %s', (value) => {
  expect(extractYouTubeVideoId(value)).toBe('');
  expect(buildYouTubeEmbedUrl(value)).toBe('');
});

test('normalizes, filters, categorizes, links, and sorts tutorial rows', () => {
  const videos = normalizeTutorialVideos([
    { Category: 'Unknown', VideoKey: 'later', Title: 'Later', YouTubeURL: '', SortOrder: '20', Active: 'TRUE', HelpTopicKey: 'history' },
    { Category: 'Quick Start', VideoKey: 'first', Title: 'First', YouTubeURL: `https://youtu.be/${ID}`, SortOrder: '10', Active: 'TRUE', HelpTopicKey: 'getting-started' },
    { Category: 'Quick Start', VideoKey: 'hidden', Title: 'Hidden', YouTubeURL: `https://youtu.be/${ID}`, SortOrder: '1', Active: 'FALSE' },
    { Category: 'Quick Start', VideoKey: 'bad', Title: 'Bad', YouTubeURL: 'https://example.com/video', SortOrder: '2', Active: 'TRUE' },
  ], 'mts');

  expect(videos.map((video) => video.videoKey)).toEqual(['first', 'later']);
  expect(videos[0]).toMatchObject({ category: 'Quick Start', helpTopicKey: 'getting-started', videoId: ID });
  expect(videos[1]).toMatchObject({ category: 'Other Tutorials', helpTopicKey: 'history', videoId: '' });
});
