import React, { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { playSound } from '../utils/sound';
import warningTriangle from '../assets/images/warning-triangle.png';
import formFilled from '../assets/images/form-filled.png';
import updateGraphic from '../assets/images/update.png';
import saveGraphic from '../assets/images/save.png';
import exitGraphic from '../assets/images/exit.png';
import questionGraphic from '../assets/images/question.png';
import callTypeGraphic from '../assets/images/calltype.png';
import formGraphic from '../assets/images/form.png';
import timeGraphic from '../assets/images/time.png';
import techGraphic from '../assets/images/tech.png';
import geminiGraphic from '../assets/images/Gemini2.png';
import mtsLogo from '../assets/images/MTSLogonew.png';

const ModalContext = createContext(null);

export function useModal() {
  return useContext(ModalContext);
}

function getModalGraphic(modal) {
  if (!modal) return null;
  if (modal.graphic === 'update') return updateGraphic;
  if (modal.graphic === 'save') return saveGraphic;
  if (modal.graphic === 'exit') return exitGraphic;
  if (modal.graphic === 'question') return questionGraphic;
  if (modal.graphic === 'calltype') return callTypeGraphic;
  if (modal.graphic === 'form') return formGraphic;
  if (modal.graphic === 'time') return timeGraphic;
  if (modal.graphic === 'tech') return techGraphic;
  if (modal.graphic === 'gemini') return geminiGraphic;
  if (modal.graphic === 'warning') return warningTriangle;
  if (modal.graphic === 'logo') return mtsLogo;
  if (modal.title === 'Form Filled') return formFilled;
  if (/gemini is enabled, but no api key/i.test(`${modal.title || ''} ${modal.body || ''}`)) return geminiGraphic;
  if (/restore defaults/i.test(modal.title || '')) return warningTriangle;
  if (/exit app/i.test(modal.title || '')) return exitGraphic;
  if (/unsaved|settings saved|session saved|finish session|save/i.test(`${modal.title || ''} ${modal.body || ''}`)) return saveGraphic;
  if (['warning', 'error', 'danger', 'confirm'].includes(modal.type)) return warningTriangle;
  return null;
}

export function ModalProvider({ children }) {
  const [modal, setModal] = useState(null);
  const resolveRef = useRef(null);

  const closeModal = useCallback((value) => {
    setModal(null);
    if (resolveRef.current) {
      resolveRef.current(value);
      resolveRef.current = null;
    }
  }, []);

  const showModal = useCallback((config) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setModal(config);
    });
  }, []);

  const alert = useCallback((title, body, icon = 'check-circle', sound = 'popup') => {
    return showModal({ type: 'alert', title, body, icon, sound, buttons: [{ label: 'OK', cls: 'btn-primary', value: true }] });
  }, [showModal]);

  const error = useCallback((title, body) => {
    return showModal({ type: 'error', title, body, icon: 'x-circle', buttons: [{ label: 'OK', cls: 'btn-danger', value: true }] });
  }, [showModal]);

  const warning = useCallback((title, body) => {
    return showModal({ type: 'warning', title, body, icon: 'alert-triangle', buttons: [{ label: 'OK', cls: 'btn-primary', value: true }] });
  }, [showModal]);

  const confirm = useCallback((title, body, icon = 'help-circle', sound = 'popup') => {
    return showModal({ type: 'confirm', title, body, icon, sound, buttons: [{ label: 'Yes', cls: 'btn-primary', value: true }, { label: 'No', cls: 'btn-muted', value: false }] });
  }, [showModal]);

  const confirmDanger = useCallback((title, body) => {
    return showModal({ type: 'danger', title, body, icon: 'trash-2', graphic: 'warning', buttons: [{ label: "Yes, I'm sure", cls: 'btn-danger', value: true }, { label: 'Cancel', cls: 'btn-muted', value: false }] });
  }, [showModal]);

  const contextValue = useMemo(() => ({
    alert,
    error,
    warning,
    confirm,
    confirmDanger,
    showModal,
  }), [alert, error, warning, confirm, confirmDanger, showModal]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && modal) {
        const lastBtn = modal.buttons[modal.buttons.length - 1];
        closeModal(lastBtn ? lastBtn.value : false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [modal, closeModal]);

  useEffect(() => {
    if (!modal) return;

    if (modal.sound) {
      playSound(modal.sound);
      return;
    }

    if (modal.type === 'warning' || modal.type === 'error' || modal.type === 'danger') {
      playSound('warning');
      return;
    }

    playSound('popup');
  }, [modal]);

  const modalGraphic = getModalGraphic(modal);

  return (
    <ModalContext.Provider value={contextValue}>
      {children}
      {modal && (
        <div className="cmodal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) closeModal(false); }}>
          <div className="cmodal">
            {modalGraphic ? (
              <img className={`cmodal-graphic ${modal.graphic === 'logo' ? 'cmodal-graphic-logo' : ''}`} src={modalGraphic} alt="" />
            ) : (
              <div className="cmodal-icon">
                <i data-lucide={modal.icon}></i>
              </div>
            )}
            <div className="cmodal-title">{modal.title}</div>
            <div className="cmodal-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(modal.body) }} />
            <div className="cmodal-btns">
              {modal.buttons.map((btn, i) => (
                <button key={i} className={`btn ${btn.cls}`} onClick={() => closeModal(btn.value)} data-testid={`modal-btn-${i}`}>
                  {btn.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </ModalContext.Provider>
  );
}
