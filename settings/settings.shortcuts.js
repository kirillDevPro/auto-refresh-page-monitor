// settings.shortcuts.js — fills the General-tab "Keyboard shortcuts" card with the LIVE bindings.
//
// The command DESCRIPTIONS are static data-i18n spans in settings.html (so updatePageTexts re-localizes
// them on a language change, reusing the existing command_* keys); this module only writes each
// command's current shortcut string, which chrome.commands.getAll() reports (empty when unbound, e.g.
// a suggested_key that collided with a user binding), and wires the "customize" button.

import { t } from './chromeI18n.js';

/**
 * Render each command's current shortcut into its `#shortcut-<command-name>` <kbd>.
 *
 * A BOUND command shows its (language-neutral) key combo and drops the data-i18n attribute; an UNBOUND
 * one keeps `data-i18n="shortcuts_not_set"` so updatePageTexts re-localizes it after an in-page language
 * change. The Commands API applies edits immediately but fires NO binding-change event, so this is also
 * re-run whenever the page becomes visible again — that is how a return from chrome://extensions/shortcuts
 * picks up a shortcut the user just changed. Best-effort: a missing API or read failure leaves the card's
 * current text rather than throwing.
 * @returns {void}
 */
function renderShortcutBindings() {
    if (!chrome.commands || !chrome.commands.getAll) return;
    chrome.commands.getAll().then((commands) => {
        for (const command of commands) {
            const keyElement = document.getElementById(`shortcut-${command.name}`);
            if (!keyElement) continue;
            if (command.shortcut) {
                keyElement.removeAttribute('data-i18n');
                keyElement.textContent = command.shortcut;
            } else {
                keyElement.setAttribute('data-i18n', 'shortcuts_not_set');
                keyElement.textContent = t('shortcuts_not_set');
            }
        }
    }).catch((error) => console.warn('shortcuts: could not read command bindings', error));
}

/**
 * Wire the "Keyboard shortcuts" card: render the live bindings now, refresh them whenever the page
 * becomes visible again (e.g. returning from the shortcut editor, which reports no change event), and
 * open chrome://extensions/shortcuts from the customize button (a chrome:// page can only be opened as a
 * tab, not linked from an <a>).
 * @returns {void}
 */
export function initializeShortcutsUI() {
    const customizeButton = document.getElementById('open-shortcuts-page');
    if (customizeButton) {
        customizeButton.addEventListener('click', () => {
            chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        });
    }

    renderShortcutBindings();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') renderShortcutBindings();
    });
}
