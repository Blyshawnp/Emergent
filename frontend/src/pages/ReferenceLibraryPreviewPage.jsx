import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  HelpCircle,
  Image,
  MessageSquareText,
  Mic,
  Search,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import PhoneticsTableButton from '../components/PhoneticsTableButton';

const HEADSET_CARDS = [
  { brand: 'Logitech', model: 'H390', status: 'Approved', connection: 'USB-A', notes: 'Noise-cancelling boom mic' },
  { brand: 'Jabra', model: 'Evolve 20', status: 'Approved', connection: 'USB', notes: 'Contact-center style headset' },
  { brand: 'Apple', model: 'AirPods', status: 'Not Approved', connection: 'Bluetooth', notes: 'Bluetooth audio is not approved for certification' },
  { brand: 'Generic', model: '3.5mm analog headset', status: 'Not Approved', connection: 'Analog', notes: 'Not USB' },
  { brand: 'Gaming headset', model: 'Requires review', status: 'Requires Review', connection: 'USB or mixed', notes: 'Review microphone type and connection before testing' },
];

const NATO_PHONETICS = [
  ['A', 'Alpha'], ['B', 'Bravo'], ['C', 'Charlie'], ['D', 'Delta'], ['E', 'Echo'], ['F', 'Foxtrot'],
  ['G', 'Golf'], ['H', 'Hotel'], ['I', 'India'], ['J', 'Juliett'], ['K', 'Kilo'], ['L', 'Lima'],
  ['M', 'Mike'], ['N', 'November'], ['O', 'Oscar'], ['P', 'Papa'], ['Q', 'Quebec'], ['R', 'Romeo'],
  ['S', 'Sierra'], ['T', 'Tango'], ['U', 'Uniform'], ['V', 'Victor'], ['W', 'Whiskey'], ['X', 'X-ray'],
  ['Y', 'Yankee'], ['Z', 'Zulu'],
];

const SECTIONS = ['Headsets', 'Verification', 'Phonetics', 'Discord', 'Screenshots', 'Troubleshooting', 'Policies', 'FAQ'];

function normalizeDiscordTemplates(items = []) {
  return items.map((item) => {
    if (Array.isArray(item)) return { category: item[2] || 'Discord', title: item[0] || 'Template', body: item[1] || '' };
    return {
      category: item.category || item.Category || 'Discord',
      title: item.title || item.Title || item.name || item.Name || 'Template',
      body: item.message || item.Message || item.text || item.Text || item.body || item.Body || '',
    };
  }).filter((item) => String(item.title || '').trim());
}

function normalizeScreenshots(items = []) {
  return items.map((item) => ({
    category: item.category || item.Category || item.group || item.Group || 'Screenshots',
    title: item.title || item.Title || item.name || item.Name || 'Screenshot',
    imageUrl: item.image_url || item.imageUrl || item.url || item.src || '',
  })).filter((item) => String(item.title || '').trim());
}

function searchableText(card) {
  return Object.values(card || {}).flat().join(' ').toLowerCase();
}

function LibraryCard({ icon: Icon = HelpCircle, title, children }) {
  return (
    <article className="reference-card">
      <div className="reference-card-icon"><Icon size={20} /></div>
      <div>
        <h3>{title}</h3>
        <div className="reference-card-body">{children}</div>
      </div>
    </article>
  );
}

export default function ReferenceLibraryPreviewPage({ settings = {}, defaults = {} }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const discordTemplates = normalizeDiscordTemplates(settings.discord_templates?.length ? settings.discord_templates : defaults.discord_templates || []);
  const screenshots = normalizeScreenshots(settings.discord_screenshots?.length ? settings.discord_screenshots : defaults.discord_screenshots || []);
  const phoneticsScreenshots = screenshots.filter((item) => /phonetics/i.test(item.title));

  const content = useMemo(() => {
    const cards = [
      ...HEADSET_CARDS.map((headset) => ({ section: 'Headsets', title: `${headset.brand} ${headset.model}`, body: `${headset.status} ${headset.connection} ${headset.notes}` })),
      { section: 'Headsets', title: 'USB vs Bluetooth', body: 'USB stable connection lower latency required for certification no pairing issues Bluetooth can disconnect audio compression pairing issues not approved' },
      { section: 'Headsets', title: 'Noise-Cancelling Microphones', body: 'Correct microphone placement microphone too far away laptop microphone webcam microphone boom microphone noise cancelling explanation' },
      ...['Verification requirements', 'Common mistakes', 'Address verification', 'DOB formatting', 'Email verification', 'Phone verification'].map((title) => ({ section: 'Verification', title, body: 'Prototype verification reference placeholder' })),
      { section: 'Phonetics', title: 'Letter-to-word reference', body: NATO_PHONETICS.flat().join(' ') },
      ...discordTemplates.slice(0, 12).map((item) => ({ section: 'Discord', title: item.title, body: `${item.category} ${item.body}` })),
      ...['Wrong headset', 'VPN', 'Screen share', 'Audio issues'].map((title) => ({ section: 'Discord', title, body: 'Discord posting example placeholder' })),
      ...screenshots.slice(0, 18).map((item) => ({ section: 'Screenshots', title: item.title, body: item.category })),
      ...['Browser cache', 'Discord audio', 'Screen share', 'Internet', 'VPN', 'Browser', 'System requirements'].map((title) => ({ section: 'Troubleshooting', title, body: 'Troubleshooting checklist placeholder' })),
      ...['Pass', 'Fail', 'Sup Transfer', 'Incomplete', 'Technical Issue', 'Readiness Judgment'].map((title) => ({ section: 'Policies', title, body: 'Policy summary placeholder' })),
      ...['Can they use AirPods?', 'What if Discord audio fails?', 'What if script does not load?', 'What if candidate leaves?', 'Can they retest?', 'What internet is acceptable?'].map((title) => ({ section: 'FAQ', title, body: 'FAQ answer placeholder' })),
    ];
    return normalizedQuery ? cards.filter((card) => searchableText(card).includes(normalizedQuery)) : cards;
  }, [discordTemplates, normalizedQuery, screenshots]);

  const visibleSections = SECTIONS.map((section) => ({
    section,
    count: content.filter((card) => card.section === section).length,
  }));

  const headsetMatches = HEADSET_CARDS.filter((card) => !normalizedQuery || searchableText(card).includes(normalizedQuery));

  return (
    <div className="reference-library-page" data-testid="reference-library-preview">
      <div className="reference-hero">
        <div>
          <div className="reference-eyebrow">Prototype</div>
          <h1>Reference Library Preview</h1>
          <p>Trainer/testing reference material, policies, visual examples, and quick lookup content. Help remains separate for app setup and support.</p>
        </div>
        <label className="reference-search">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search reference cards..." data-testid="reference-library-search" />
        </label>
      </div>

      <div className="reference-tabs" aria-label="Reference library sections">
        {visibleSections.map(({ section, count }) => (
          <a key={section} href={`#reference-${section.toLowerCase().replace(/\s+/g, '-')}`} className={count ? '' : 'is-empty'}>
            {section}<span>{count}</span>
          </a>
        ))}
      </div>

      <section id="reference-headsets" className="reference-section">
        <h2>Headsets</h2>
        <div className="reference-card-grid headset-grid">
          {headsetMatches.map((headset) => (
            <article key={`${headset.brand}-${headset.model}`} className="headset-reference-card">
              <div className="headset-picture"><Mic size={28} /></div>
              <div className="headset-brand">{headset.brand}</div>
              <div className="headset-model">{headset.model}</div>
              <div className={`headset-status status-${headset.status.toLowerCase().replace(/\s+/g, '-')}`}>{headset.status}</div>
              <div className="reference-meta">{headset.connection}</div>
              <p>{headset.notes}</p>
            </article>
          ))}
          {(!normalizedQuery || 'usb bluetooth stable disconnect latency certification pairing approved'.includes(normalizedQuery)) && (
            <LibraryCard icon={Cable} title="USB vs Bluetooth">
              <div className="comparison-grid">
                <div><strong>USB</strong><ul><li>Stable connection</li><li>Lower latency</li><li>Required for certification</li><li>No pairing issues</li></ul></div>
                <div><strong>Bluetooth</strong><ul><li>Can disconnect</li><li>Audio compression</li><li>Pairing issues</li><li>Not approved</li></ul></div>
              </div>
            </LibraryCard>
          )}
          {(!normalizedQuery || 'noise microphone boom laptop webcam placement'.includes(normalizedQuery)) && (
            <LibraryCard icon={Mic} title="Noise-Cancelling Microphones">
              <div className="microphone-examples">
                {['Correct placement', 'Too far away', 'Laptop microphone', 'Webcam microphone', 'Boom microphone'].map((label) => <span key={label}>{label}</span>)}
              </div>
              <p>Noise-cancelling boom microphones reduce room noise and keep the caller audio consistent.</p>
            </LibraryCard>
          )}
        </div>
      </section>

      <section id="reference-verification" className="reference-section">
        <h2>Verification</h2>
        <div className="reference-card-grid">
          {['Verification requirements', 'Common mistakes', 'Address verification', 'DOB formatting', 'Email verification', 'Phone verification'].filter((title) => !normalizedQuery || title.toLowerCase().includes(normalizedQuery)).map((title) => (
            <LibraryCard key={title} icon={ShieldCheck} title={title}>Prototype summary placeholder for future trainer-approved content.</LibraryCard>
          ))}
        </div>
      </section>

      <section id="reference-phonetics" className="reference-section">
        <h2>Phonetics</h2>
        <div className="reference-card-grid">
          <LibraryCard icon={MessageSquareText} title="Phonetics reference only">
            <p>Use this section as the single obvious phonetics reference. It is intentionally not repeated on Call or Supervisor Transfer screens.</p>
            <PhoneticsTableButton screenshots={phoneticsScreenshots} />
          </LibraryCard>
          <article className="reference-card phonetics-reference-table">
            <h3>Letter-to-word table</h3>
            <div>
              {NATO_PHONETICS.map(([letter, word]) => <span key={letter}><b>{letter}</b> {word}</span>)}
            </div>
          </article>
        </div>
      </section>

      {['Discord', 'Screenshots', 'Troubleshooting', 'Policies', 'FAQ'].map((section) => {
        const cards = content.filter((card) => card.section === section);
        return (
          <section key={section} id={`reference-${section.toLowerCase()}`} className="reference-section">
            <h2>{section}</h2>
            <div className="reference-card-grid">
              {cards.length ? cards.map((card) => (
                <LibraryCard key={`${card.section}-${card.title}`} icon={section === 'Screenshots' ? Image : section === 'FAQ' ? HelpCircle : section === 'Policies' ? CheckCircle2 : section === 'Troubleshooting' ? AlertTriangle : MessageSquareText} title={card.title}>
                  {card.body || 'Prototype placeholder for future approved content.'}
                </LibraryCard>
              )) : <div className="reference-empty"><XCircle size={18} /> No {section.toLowerCase()} cards match this search.</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
