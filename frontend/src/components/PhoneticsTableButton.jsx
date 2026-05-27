import React, { useState } from 'react';

const PHONETICS_IMAGE = '/Phonetics.png';

async function copyPhoneticsImage() {
  if (navigator.clipboard?.write && window.ClipboardItem) {
    const response = await fetch(PHONETICS_IMAGE);
    if (!response.ok) throw new Error(`Image request failed with status ${response.status}`);
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) throw new Error('Phonetics file is not an image.');
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return 'image';
  }

  const fallback = `${window.location.origin}${PHONETICS_IMAGE}`;
  await navigator.clipboard.writeText(fallback);
  return 'link';
}

export default function PhoneticsTableButton() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');

  const handleCopy = async () => {
    try {
      const copiedType = await copyPhoneticsImage();
      setCopyMessage(copiedType === 'image' ? 'Image copied for Discord paste.' : 'Image copy is not supported here. A link was copied instead.');
    } catch (error) {
      try {
        await navigator.clipboard.writeText(`${window.location.origin}${PHONETICS_IMAGE}`);
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
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)} data-testid="phonetics-table-button">
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
              <img className="phonetics-image" src={PHONETICS_IMAGE} alt="Phonetics table" />
              {copyMessage && <div className="text-sm phonetics-copy-status">{copyMessage}</div>}
              <div className="phonetics-actions">
                <button type="button" className={`btn btn-primary btn-sm ${copied ? 'copied' : ''}`} onClick={handleCopy} data-testid="phonetics-copy">
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
