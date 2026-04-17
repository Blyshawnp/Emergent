/**
 * modal.js — Custom modal dialogs to replace browser alert/confirm.
 * No more "127.0.0.1:8600 says" headers. Proper Yes/No buttons.
 *
 * Usage:
 *   import { modal } from './modal.js';
 *   await modal.alert('Session Saved', 'Your session has been saved successfully.');
 *   const yes = await modal.confirm('Exit App', 'Are you sure you want to exit?');
 *   if (yes) { ... }
 */

let _overlay = null;

function getOverlay() {
  if (_overlay) return _overlay;
  _overlay = document.createElement('div');
  _overlay.id = 'custom-modal-overlay';
  _overlay.className = 'cmodal-overlay';
  _overlay.innerHTML = `
    <div class="cmodal" id="custom-modal">
      <div class="cmodal-icon" id="cmodal-icon"></div>
      <div class="cmodal-title" id="cmodal-title"></div>
      <div class="cmodal-body" id="cmodal-body"></div>
      <div class="cmodal-btns" id="cmodal-btns"></div>
    </div>
  `;
  document.body.appendChild(_overlay);
  return _overlay;
}

function show(icon, title, body, buttons) {
  return new Promise(resolve => {
    const overlay = getOverlay();
    document.getElementById('cmodal-icon').textContent = icon;
    document.getElementById('cmodal-title').textContent = title;
    document.getElementById('cmodal-body').innerHTML = body;

    const btnsEl = document.getElementById('cmodal-btns');
    btnsEl.innerHTML = '';

    buttons.forEach(({ label, cls, value }) => {
      const btn = document.createElement('button');
      btn.className = `btn ${cls}`;
      btn.textContent = label;
      btn.onclick = () => {
        overlay.classList.remove('open');
        setTimeout(() => resolve(value), 200);
      };
      btnsEl.appendChild(btn);
    });

    requestAnimationFrame(() => overlay.classList.add('open'));

    // Close on Escape = last button's value (cancel/no)
    const handler = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', handler);
        overlay.classList.remove('open');
        setTimeout(() => resolve(buttons[buttons.length - 1].value), 200);
      }
    };
    document.addEventListener('keydown', handler);
  });
}

export const modal = {
  /** Show an info alert with OK button. */
  alert(title, body, icon = '✅') {
    return show(icon, title, body, [
      { label: 'OK', cls: 'btn-primary', value: true },
    ]);
  },

  /** Show an error alert. */
  error(title, body) {
    return show('❌', title, body, [
      { label: 'OK', cls: 'btn-danger', value: true },
    ]);
  },

  /** Show a warning alert. */
  warning(title, body) {
    return show('⚠️', title, body, [
      { label: 'OK', cls: 'btn-primary', value: true },
    ]);
  },

  /** Show a Yes/No confirmation. Returns true if Yes clicked. */
  confirm(title, body, icon = '❓') {
    return show(icon, title, body, [
      { label: 'Yes', cls: 'btn-primary', value: true },
      { label: 'No', cls: 'btn-muted', value: false },
    ]);
  },

  /** Show a confirmation with custom button labels. */
  confirmCustom(title, body, yesLabel, noLabel, icon = '❓') {
    return show(icon, title, body, [
      { label: yesLabel, cls: 'btn-primary', value: true },
      { label: noLabel, cls: 'btn-muted', value: false },
    ]);
  },

  /** Dangerous confirmation (red Yes button). */
  confirmDanger(title, body, icon = '🗑') {
    return show(icon, title, body, [
      { label: 'Yes, I\'m sure', cls: 'btn-danger', value: true },
      { label: 'Cancel', cls: 'btn-muted', value: false },
    ]);
  },
};
