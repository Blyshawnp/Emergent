import React, { useEffect, useRef } from 'react';
import './tutorial-video.css';

export default function PostSetupQuickStart({ app = 'mts', onWatch, onGuide, onContinue }) {
  const firstActionRef = useRef(null);
  const onContinueRef = useRef(onContinue);
  const isSam = app === 'sam';
  const product = isSam ? 'Smart Alert Manager' : 'Mock Testing Suite';

  useEffect(() => { onContinueRef.current = onContinue; }, [onContinue]);

  useEffect(() => {
    firstActionRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onContinueRef.current?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className={`post-setup-quick-start ${isSam ? 'is-sam' : 'is-mts'}`} role="dialog" aria-modal="true" aria-labelledby={`${app}-quick-start-title`} data-testid={`${app}-quick-start`}>
      <section className="post-setup-card">
        <div className="post-setup-kicker">Setup complete</div>
        <h1 id={`${app}-quick-start-title`}>Welcome to {product}</h1>
        <p>Your setup choices are saved. Choose a quick next step, or skip directly into the app.</p>
        <p className="post-setup-note">Tutorials remain available anytime under Help → Tutorial Videos.</p>
        <div className="post-setup-actions">
          <button ref={firstActionRef} type="button" className="post-setup-primary" onClick={onWatch}>
            Watch the {isSam ? 'SAM' : 'MTS'} Quick Start
          </button>
          <button type="button" onClick={onGuide}>Open the {isSam ? 'SAM' : 'MTS'} User Guide</button>
          <button type="button" onClick={onContinue}>Go to {isSam ? 'SAM Dashboard' : 'MTS Home'}</button>
        </div>
      </section>
    </div>
  );
}
