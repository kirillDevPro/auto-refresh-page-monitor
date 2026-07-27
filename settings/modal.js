// modal.js - Modal and toast notification system for settings pages

import { escapeHtml } from './htmlUtils.js';

let toastContainer = null;

/**
 * Lazily create (and cache) the singleton `.toast-container` element appended to document.body.
 * @returns {HTMLElement} The shared toast container, reused on subsequent calls.
 */
function initToastContainer() {
    if (toastContainer) return toastContainer;

    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
    return toastContainer;
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {string} type - Type: 'success', 'error', 'warning', 'info'
 * @param {number} duration - Duration in ms (default 3500)
 */
export function showToast(message, type = 'info', duration = 3500) {
    const container = initToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    // Icon based on type
    const icons = {
        success: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>',
        error: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>',
        warning: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
        info: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>'
    };

    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-message">${escapeHtml(message)}</span>
        <button class="toast-close" aria-label="Close">&times;</button>
    `;

    // Close button handler
    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => removeToast(toast));

    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('toast-visible');
    });

    // Auto-remove after duration
    if (duration > 0) {
        setTimeout(() => removeToast(toast), duration);
    }

    return toast;
}

/**
 * Animate a toast out and remove it from the DOM after the 300ms transition.
 * No-op if the toast is already detached.
 * @param {HTMLElement} toast - The toast element to dismiss.
 */
function removeToast(toast) {
    if (!toast || !toast.parentNode) return;

    toast.classList.remove('toast-visible');
    toast.classList.add('toast-hiding');

    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 300);
}

/**
 * Show a confirm dialog
 * @param {string} message - Message to display
 * @param {string} title - Dialog title (optional)
 * @param {Object} options - Options: confirmText, cancelText, type
 * @returns {Promise<boolean>} - true if confirmed, false if cancelled
 */
export function showConfirm(message, title = '', options = {}) {
    return new Promise((resolve) => {
        const {
            confirmText = 'OK',
            cancelText = 'Cancel',
            type = 'warning'
        } = options;

        // Create backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';

        // Create modal
        const modal = document.createElement('div');
        modal.className = `modal modal-${type}`;
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const icons = {
            warning: '<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
            danger: '<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
            info: '<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>'
        };

        modal.innerHTML = `
            <div class="modal-icon">${icons[type] || icons.warning}</div>
            ${title ? `<h3 class="modal-title">${escapeHtml(title)}</h3>` : ''}
            <p class="modal-message">${escapeHtml(message)}</p>
            <div class="modal-actions">
                <button class="modal-btn modal-btn-cancel">${escapeHtml(cancelText)}</button>
                <button class="modal-btn modal-btn-confirm">${escapeHtml(confirmText)}</button>
            </div>
        `;

        // Add to DOM
        document.body.appendChild(backdrop);
        document.body.appendChild(modal);

        // Animate in
        requestAnimationFrame(() => {
            backdrop.classList.add('modal-backdrop-visible');
            modal.classList.add('modal-visible');
        });

        // Handle clicks
        const confirmBtn = modal.querySelector('.modal-btn-confirm');
        const cancelBtn = modal.querySelector('.modal-btn-cancel');

        function cleanup(result) {
            // Remove the document-level listener on ANY close path (button/backdrop/Escape);
            // otherwise closing via click left a dangling keydown listener that kept the
            // detached modal DOM alive (a leak on the long-lived options page).
            document.removeEventListener('keydown', handleKeydown);
            backdrop.classList.remove('modal-backdrop-visible');
            modal.classList.remove('modal-visible');

            setTimeout(() => {
                backdrop.remove();
                modal.remove();
            }, 200);

            resolve(result);
        }

        confirmBtn.addEventListener('click', () => cleanup(true));
        cancelBtn.addEventListener('click', () => cleanup(false));
        backdrop.addEventListener('click', () => cleanup(false));

        // Handle Escape key
        function handleKeydown(e) {
            if (e.key === 'Escape') cleanup(false);
        }
        document.addEventListener('keydown', handleKeydown);

        // Focus confirm button
        confirmBtn.focus();
    });
}

/**
 * Shorthand helpers that call showToast() with a preset type.
 * Each takes (msg, duration) and forwards to showToast(msg, <type>, duration).
 * @type {{ success: Function, error: Function, warning: Function, info: Function }}
 */
export const toast = {
    success: (msg, duration) => showToast(msg, 'success', duration),
    error: (msg, duration) => showToast(msg, 'error', duration),
    warning: (msg, duration) => showToast(msg, 'warning', duration),
    info: (msg, duration) => showToast(msg, 'info', duration)
};
