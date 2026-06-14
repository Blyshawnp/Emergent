import React, { useEffect, useState } from 'react';
import { findScreenshotByTitle, resolveScreenshotUrl } from '../utils/screenshotAssets';

const FALLBACK_PHONETICS_IMAGE = '/Phonetics.png';

async function copyPhoneticsImage(imageUrl) {
  if (navigator.clipboard?.write && window.ClipboardItem) {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Image request failed with status ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('Phonetics file is not an image.');
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return 'image';
  }

  await navigator.clipboard.writeText(imageUrl);
  return 'link';
}

export default function PhoneticsTableButton({ screenshots = [] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const phoneticsScreenshot = findScreenshotByTitle(screenshots, /phonetics/i);
  const imagePath = phoneticsScreenshot?.image_url || FALLBACK_PHONETICS_IMAGE;
  const imageUrl = resolveScreenshotUrl(imagePath);

  useEffect(() => {
    setImageFailed(false);
  }, [imageUrl, open]);

  const handleCopy = async () => {
    try {
      const copiedType = await copyPhoneticsImage(imageUrl);
      setCopyMessage(copiedType === 'image' ? 'Image copied for Discord paste.' : 'Image copy is not supported here. A link was copied instead.');
    } catch (error) {
      try {
        await navigator.clipboard.writeText(imageUrl);
        setCopyMessage('Image copy failed. A link was copied instead.');
      } catch (_fallbackError) {
        setCopyMessage(error?.message || 'Unable to copy the phonetics table.');
      }
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 3000);
  };

  return (
    <>
      <button type="button" className="btn btn-primary btn-sm phonetics-table-trigger" onClick={() => setOpen(true)} data-testid="phonetics-table-button">
        Phonetics Table
      </button>
      {open && (
        <div className="modal-overlay open" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div className="modal phonetics-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Phonetics Table</h2>
              <button className="modal-close" onClick={() => setOpen(false)}>&times;</button>
            </div>
            <div className="modal-body">
              {imageUrl && !imageFailed ? (
                <img
                  className="phonetics-image"
                  src={imageUrl}
                  alt="Phonetics table"
                  onError={() => setImageFailed(true)}
                />
              ) : (
                <div className="phonetics-image phonetics-image-fallback">Phonetics table image could not be loaded.</div>
              )}
              {copyMessage && <div className="text-sm phonetics-copy-status">{copyMessage}</div>}
              <div className="phonetics-actions">
                <button type="button" className={`btn btn-primary btn-sm ${copied ? 'copied' : ''}`} onClick={handleCopy} disabled={!imageUrl || imageFailed} data-testid="phonetics-copy">
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
