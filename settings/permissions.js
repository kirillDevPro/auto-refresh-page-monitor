/**
 * Provides settings-page helpers for the optional webNavigation permission used by auto-recovery.
 *
 * The permission is requested at runtime from user gestures rather than declared as a required
 * manifest permission, so declining it leaves unrelated refresh features working.
 */
import { t } from './chromeI18n.js';

// Static, trusted info-icon markup reused from the shared modal styling (no user data — safe innerHTML).
const INFO_ICON_SVG = '<svg viewBox="0 0 24 24" width="48" height="48"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';

/**
 * Show an explanation dialog and, ONLY if the user clicks Enable, request the optional webNavigation
 * permission. The request fires as the first await inside the Enable button's own click handler, so it
 * stays within that click's transient user activation and Chrome shows its native prompt (a request
 * issued after `await`-ing a separate confirm helper would be past the gesture and silently fail).
 * Cancel / backdrop / Escape resolve false without requesting anything.
 * @returns {Promise<boolean>} true only if the user confirmed AND the permission was granted.
 */
export function confirmAndRequestWebNavigation() {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';

        const modal = document.createElement('div');
        modal.className = 'modal modal-info';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        const iconDiv = document.createElement('div');
        iconDiv.className = 'modal-icon';
        iconDiv.innerHTML = INFO_ICON_SVG;

        const titleEl = document.createElement('h3');
        titleEl.className = 'modal-title';
        titleEl.textContent = t('recover_perm_dialog_title');

        const messageEl = document.createElement('p');
        messageEl.className = 'modal-message';
        messageEl.textContent = t('recover_perm_dialog_body');

        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn modal-btn-cancel';
        cancelBtn.textContent = t('cancel');
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modal-btn modal-btn-confirm';
        confirmBtn.textContent = t('enable');
        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);

        modal.appendChild(iconDiv);
        modal.appendChild(titleEl);
        modal.appendChild(messageEl);
        modal.appendChild(actions);
        document.body.appendChild(backdrop);
        document.body.appendChild(modal);
        requestAnimationFrame(() => {
            backdrop.classList.add('modal-backdrop-visible');
            modal.classList.add('modal-visible');
        });

        let settled = false;
        function cleanup(result) {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', handleKeydown);
            backdrop.classList.remove('modal-backdrop-visible');
            modal.classList.remove('modal-visible');
            setTimeout(() => { backdrop.remove(); modal.remove(); }, 200);
            resolve(result);
        }

        confirmBtn.addEventListener('click', async () => {
            confirmBtn.disabled = true; // guard against a double-click issuing two prompts
            let granted = false;
            try {
                granted = await chrome.permissions.request({ permissions: ['webNavigation'] });
            } catch (e) {
                console.warn('webNavigation permission request failed:', e?.message);
            }
            cleanup(granted);
        });
        cancelBtn.addEventListener('click', () => cleanup(false));
        backdrop.addEventListener('click', () => cleanup(false));
        function handleKeydown(e) { if (e.key === 'Escape') cleanup(false); }
        document.addEventListener('keydown', handleKeydown);
        confirmBtn.focus();
    });
}

/**
 * Request the optional webNavigation permission, returning whether it is granted. Calls
 * chrome.permissions.request directly inside the caller's user gesture; it is idempotent (resolves
 * true without a prompt when already granted), so there is no preceding contains() check that could
 * consume the gesture. MUST be called synchronously from a user-gesture handler (e.g. a checkbox
 * 'change' or a modal-save click) for the runtime prompt to appear.
 * @returns {Promise<boolean>} true if the permission is (now) granted.
 */
export async function ensureWebNavigationPermission() {
    try {
        return await chrome.permissions.request({ permissions: ['webNavigation'] });
    } catch (e) {
        console.warn('webNavigation permission request failed:', e?.message);
        return false;
    }
}

/**
 * Report whether the optional webNavigation permission is currently granted (no prompt).
 * @returns {Promise<boolean>} true if webNavigation is currently granted.
 */
export async function hasWebNavigationPermission() {
    try {
        return await chrome.permissions.contains({ permissions: ['webNavigation'] });
    } catch (e) {
        return false;
    }
}
