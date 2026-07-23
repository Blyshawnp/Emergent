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
const notificationGraphic = `${process.env.PUBLIC_URL || ''}/sam-banner.png`;

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
  if (modal.graphic === 'notification') return notificationGraphic;
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
  const dialogRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const modalGenerationRef = useRef(0);

  const closeModal = useCallback((value) => {
    const closingGeneration = modalGenerationRef.current;
    setModal(null);
    if (resolveRef.current) {
      resolveRef.current(value);
      resolveRef.current = null;
    }
    window.setTimeout(() => {
      if (modalGenerationRef.current !== closingGeneration) return;
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target && typeof target.focus === 'function' && document.contains(target)) target.focus();
    }, 0);
  }, []);

  const showModal = useCallback((config) => {
    return new Promise((resolve) => {
      modalGenerationRef.current += 1;
      if (!restoreFocusRef.current && document.activeElement instanceof HTMLElement) {
        restoreFocusRef.current = document.activeElement;
      }
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
    return showModal({ type: 'confirm', title, body, icon, sound, buttons: [{ label: 'No', cls: 'btn-muted', value: false }, { label: 'Yes', cls: 'btn-primary', value: true }] });
  }, [showModal]);

  const confirmDanger = useCallback((title, body) => {
    return showModal({ type: 'danger', title, body, icon: 'trash-2', graphic: 'warning', buttons: [{ label: 'Cancel', cls: 'btn-muted', value: false }, { label: "Yes, I'm sure", cls: 'btn-danger', value: true }] });
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
        const safeBtn = modal.buttons.find((btn) => btn.value === false || btn.value === 'cancel' || /cancel|back|no/i.test(btn.label || ''));
        closeModal(safeBtn ? safeBtn.value : false);
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

  useEffect(() => {
    if (!modal || typeof modal.onMount !== 'function') return undefined;
    const cleanup = modal.onMount();
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [modal]);

  useEffect(() => {
    if (!modal || !dialogRef.current) return;
    const safeButton = dialogRef.current.querySelector('[data-modal-safe="true"]');
    const firstButton = dialogRef.current.querySelector('button:not([disabled])');
    (safeButton || firstButton)?.focus();
  }, [modal]);

  const trapDialogFocus = useCallback((event) => {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const modalGraphic = getModalGraphic(modal);

  return (
    <ModalContext.Provider value={contextValue}>
      {children}
      {modal && (
        <div className="cmodal-overlay open">
          <div
            className="cmodal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={modal.title || 'Dialog'}
            onKeyDown={trapDialogFocus}
          >
            {modalGraphic ? (
              <img
                className={`cmodal-graphic ${modal.graphic === 'logo' ? 'cmodal-graphic-logo' : ''}`}
                src={modalGraphic}
                alt=""
                onError={(event) => {
                  if (event.currentTarget.src !== mtsLogo) {
                    event.currentTarget.src = mtsLogo;
                  }
                }}
              />
            ) : (
              <div className="cmodal-icon">
                <i data-lucide={modal.icon}></i>
              </div>
            )}
            <div className="cmodal-title">{modal.title}</div>
            <div className="cmodal-body" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(modal.body) }} />
            <div className="cmodal-btns">
              {modal.buttons.map((btn, i) => (
                <button
                  key={i}
                  className={`btn ${btn.cls}`}
                  onClick={() => closeModal(btn.value)}
                  data-testid={`modal-btn-${i}`}
                  data-modal-safe={btn.value === false || btn.value === 'cancel' || /cancel|back|no/i.test(btn.label || '') ? 'true' : 'false'}
                >
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
