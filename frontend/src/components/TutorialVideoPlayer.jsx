import React, { useEffect, useMemo, useState } from 'react';
import {
  buildYouTubeEmbedUrl,
  buildYouTubeWatchUrl,
  groupTutorialVideos,
} from '../utils/tutorialVideos';
import './tutorial-video.css';

export async function openTutorialInBrowser(video) {
  const url = buildYouTubeWatchUrl(video?.youtubeUrl || video?.videoId);
  if (!url) return false;
  if (window.electronAPI?.openExternal) {
    await window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return true;
}

export function TutorialVideoPlayer({ video, onClose }) {
  const [retryKey, setRetryKey] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const embedUrl = useMemo(() => buildYouTubeEmbedUrl(video?.youtubeUrl || video?.videoId), [video]);

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  if (!video) return null;
  const unavailable = !embedUrl || !online || loadError;

  return (
    <section className="tutorial-player" aria-labelledby="tutorial-player-title" data-testid="tutorial-player">
      <div className="tutorial-player-heading">
        <div>
          <span className="tutorial-player-category">{video.category}</span>
          <h3 id="tutorial-player-title">{video.title}</h3>
          {video.description ? <p>{video.description}</p> : null}
          <div className="tutorial-player-meta">
            {video.duration ? <span>{video.duration}</span> : null}
            {video.audience ? <span>{video.audience}</span> : null}
          </div>
        </div>
        {onClose ? <button type="button" className="tutorial-close" onClick={onClose} aria-label={`Close ${video.title} tutorial`}>×</button> : null}
      </div>

      {unavailable ? (
        <div className="tutorial-unavailable" role="status">
          <strong>{!online ? 'You appear to be offline.' : embedUrl ? 'The tutorial could not be loaded.' : 'Video Coming Soon'}</strong>
          <span>Written Help remains available while the video is unavailable.</span>
          <div className="tutorial-actions">
            {embedUrl ? (
              <button type="button" onClick={() => { setLoadError(false); setRetryKey((key) => key + 1); }}>Try Again</button>
            ) : null}
            {embedUrl ? <button type="button" onClick={() => openTutorialInBrowser(video)}>Open in Browser</button> : null}
          </div>
        </div>
      ) : (
        <div className="tutorial-aspect-ratio">
          <iframe
            key={retryKey}
            src={embedUrl}
            title={`${video.title} tutorial video`}
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowFullScreen
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            onError={() => setLoadError(true)}
            data-testid="tutorial-iframe"
          />
        </div>
      )}
      {embedUrl ? (
        <div className="tutorial-browser-row">
          <button type="button" onClick={() => openTutorialInBrowser(video)} aria-label={`Open ${video.title} tutorial in browser`}>
            Open in Browser
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function TutorialVideoLibrary({ videos, title = 'Tutorial Videos', onSelectVideo, selectedVideo, sectionId = 'tutorial-videos' }) {
  const [internalSelected, setInternalSelected] = useState(null);
  const controlled = selectedVideo !== undefined;
  const selected = controlled ? selectedVideo : internalSelected;
  const groups = useMemo(() => groupTutorialVideos(Array.isArray(videos) ? videos : []), [videos]);
  const selectVideo = (video) => {
    if (!controlled) setInternalSelected(video);
    onSelectVideo?.(video);
  };
  const selectedBelongsHere = selected && (Array.isArray(videos) ? videos : []).some((video) => video.app === selected.app && video.videoKey === selected.videoKey);

  return (
    <section className="tutorial-library" id={sectionId} data-testid="tutorial-video-library">
      <div className="tutorial-library-heading">
        <h2>{title}</h2>
        <p>Videos are supplemental. Every workflow remains documented in written Help.</p>
      </div>
      {selectedBelongsHere ? <TutorialVideoPlayer video={selected} onClose={() => { if (!controlled) setInternalSelected(null); onSelectVideo?.(null); }} /> : null}
      {Object.keys(groups).length ? Object.entries(groups).map(([category, items]) => (
        <section key={category} className="tutorial-category" aria-labelledby={`tutorial-category-${category.replace(/\W+/g, '-').toLowerCase()}`}>
          <h3 id={`tutorial-category-${category.replace(/\W+/g, '-').toLowerCase()}`}>{category}</h3>
          <div className="tutorial-card-grid">
            {items.map((video) => (
              <article key={`${video.app}-${video.videoKey}`} className="tutorial-card">
                <div>
                  <h4>{video.title}</h4>
                  {video.description ? <p>{video.description}</p> : null}
                </div>
                <div className="tutorial-card-meta">
                  {video.duration ? <span>{video.duration}</span> : null}
                  {video.audience ? <span>{video.audience}</span> : null}
                </div>
                <div className="tutorial-actions">
                  {video.videoId ? (
                    <button type="button" onClick={() => selectVideo(video)} aria-label={`Play ${video.title} tutorial`}>Play Tutorial</button>
                  ) : <span className="tutorial-coming-soon">Video Coming Soon</span>}
                  {video.videoId ? <button type="button" onClick={() => openTutorialInBrowser(video)}>Open in Browser</button> : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      )) : (
        <div className="tutorial-empty">No active tutorial videos are published yet. Use the written guide or replay the guided walkthrough.</div>
      )}
    </section>
  );
}
