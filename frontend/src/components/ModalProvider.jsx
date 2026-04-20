import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { playSound } from '../utils/sound';

const ModalContext = createContext(null);

export function useModal() {
  return useContext(ModalContext);
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
    return showModal({ type: 'danger', title, body, icon: 'trash-2', buttons: [{ label: "Yes, I'm sure", cls: 'btn-danger', value: true }, { label: 'Cancel', cls: 'btn-muted', value: false }] });
  }, [showModal]);

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

  return (
    <ModalContext.Provider value={{ alert, error, warning, confirm, confirmDanger, showModal }}>
      {children}
      {modal && (
        <div className="cmodal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) closeModal(false); }}>
          <div className="cmodal">
            <div className="cmodal-icon">
              <i data-lucide={modal.icon}></i>
            </div>
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
