/**
 * Renders and manages URL-pattern scheduled-refresh rules in the settings page.
 *
 * Provides search, pagination, add/edit/delete/toggle CRUD, validation, rule-count updates, and
 * recovery-mode display through the shared schedule modal and mode-label helpers.
 */
import { getGlobalSettings, setGlobalSettings, saveAndApplyGlobalSettings } from './settings.global.js';
import { t } from './chromeI18n.js';
import { formatIntervalLong } from './timeFormat.js';
import { showConfirm } from './modal.js';
import { openScheduleModal } from './scheduleModal.js';
import { refreshModeLabel } from './refreshModes.js';
import { jitterModeLabel } from './jitterModes.js';
import { recoverModeLabel } from './recoverModes.js';
import { escapeHtml } from './htmlUtils.js';
import { normalizeUrl, schedulePatternsOverlap, isValidSchedulePattern } from './scheduleUtils.js';

/**
 * Maximum number of scheduled-refresh rules a user may create. Single source of
 * truth: the counter badge, the limit-reached guard, and the localized warning
 * message all derive from this value (the message embeds it via the {max} token).
 */
export const MAX_SCHEDULES = 300;

// Pagination state for the schedules list
let currentSchedulePage = 1;
let schedulesPerPage = 10; // Show 10 schedules per page
let allSchedules = [];
let filteredSchedules = []; // Holds the search-filtered subset
let currentSearchQuery = '';

// DOM Elements that this module will need (passed during setup)
let addScheduledRefreshButton, scheduledListUl;

// Search DOM elements
let schedulesSearchInput, clearSearchBtn, searchResultsInfo;

// Schedules pagination DOM elements
let schedulesPaginationContainer, schedulesPaginationInfoText, schedulesPaginationPages;
let schedulesPaginationFirstBtn, schedulesPaginationPrevBtn, schedulesPaginationNextBtn, schedulesPaginationLastBtn;

// Schedules count badge element
let schedulesCountElement;

/**
 * Wire up the scheduled-refreshes UI: cache DOM references (add button, list,
 * pagination controls, count badge, search input), insert the search-results-info
 * element, attach add/search/pagination event listeners, and do the initial render.
 * @param {Object} elements - DOM references collected by settings.js (addScheduledRefreshButton, scheduledListUl, optional schedulesCountElement).
 * @returns {void}
 */
export function initializeScheduledRefreshesUI(elements) {
    addScheduledRefreshButton = elements.addScheduledRefreshButton;
    scheduledListUl = elements.scheduledListUl;

    // Schedules pagination DOM elements
    schedulesPaginationContainer = document.getElementById('schedules-pagination-container');
    schedulesPaginationInfoText = document.getElementById('schedules-pagination-info-text');
    schedulesPaginationPages = document.getElementById('schedules-pagination-pages');
    schedulesPaginationFirstBtn = document.getElementById('schedules-pagination-first');
    schedulesPaginationPrevBtn = document.getElementById('schedules-pagination-prev');
    schedulesPaginationNextBtn = document.getElementById('schedules-pagination-next');
    schedulesPaginationLastBtn = document.getElementById('schedules-pagination-last');

    // Count badge element - fall back to a direct getElementById lookup for reliability
    schedulesCountElement = elements.schedulesCountElement || document.getElementById('schedules-count');

    // Search DOM elements
    schedulesSearchInput = document.getElementById('schedules-search');
    clearSearchBtn = document.getElementById('clear-search');

    // Create the element that displays search-results info
    if (scheduledListUl && scheduledListUl.parentNode) {
        searchResultsInfo = document.createElement('div');
        searchResultsInfo.className = 'search-results-info';
        searchResultsInfo.style.display = 'none';
        scheduledListUl.parentNode.insertBefore(searchResultsInfo, scheduledListUl);
    }

    // If the count element wasn't found, retry locating it after a short delay
    if (!schedulesCountElement) {
        setTimeout(() => {
            schedulesCountElement = document.getElementById('schedules-count');
            if (schedulesCountElement) {
                forceUpdateCounter();
            }
        }, 100);
    }

    if (addScheduledRefreshButton) {
        addScheduledRefreshButton.addEventListener('click', openAddScheduleModal);
    }

    // Search handlers
    if (schedulesSearchInput) {
        schedulesSearchInput.addEventListener('input', handleSearchInput);
        schedulesSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                clearSearch();
            }
        });
    }
    if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', clearSearch);
    }

    // Pagination handlers
    if (schedulesPaginationFirstBtn) {
        schedulesPaginationFirstBtn.addEventListener('click', () => goToSchedulePage(1));
    }
    if (schedulesPaginationPrevBtn) {
        schedulesPaginationPrevBtn.addEventListener('click', () => goToSchedulePage(currentSchedulePage - 1));
    }
    if (schedulesPaginationNextBtn) {
        schedulesPaginationNextBtn.addEventListener('click', () => goToSchedulePage(currentSchedulePage + 1));
    }
    if (schedulesPaginationLastBtn) {
        schedulesPaginationLastBtn.addEventListener('click', () => goToSchedulePage(Math.ceil(getDisplaySchedules().length / schedulesPerPage)));
    }

    // Initial render
    renderScheduledRefreshes(); // Render any existing items

    // Force a counter refresh after initialization
    setTimeout(() => {
        forceUpdateCounter();
    }, 500);
}

// Interval lower bound: in a packed extension Chrome clamps alarms < 30s up to 30s.
const MIN_INTERVAL_SECONDS = 30;

/**
 * Validate schedule data collected from the modal: required fields, the 30s interval floor, a valid
 * http(s) URL / prefix pattern, an exact-duplicate URL (normalized) or a strict pattern overlap with
 * an existing rule (raw, runtime grammar), and the max-schedules limit when adding.
 * @param {Object} data - Candidate schedule data from the modal.
 * @param {string|null} excludeId - Existing rule id to skip during duplicate and overlap checks in edit mode.
 * @returns {string|null} Localized error message when invalid (exact duplicate wins over overlap), otherwise null.
 */
function validateScheduleData(data, excludeId) {
    if (!data.url || !data.interval) {
        return t('invalid_schedule_input');
    }
    if (data.interval < MIN_INTERVAL_SECONDS) {
        return t('min_interval_warning');
    }

    const currentSettings = getGlobalSettings();
    const list = currentSettings.scheduledRefreshes || [];

    // Duplicate/overlap checks run only when the URL is new or changed. Editing a rule without
    // changing its URL (an interval/mode/enabled edit) cannot introduce a NEW conflict, and a
    // pre-existing overlap - e.g. from an imported profile, or a rule created before overlap-blocking
    // shipped - must not trap the user out of editing that rule's other fields.
    const editingItem = excludeId ? list.find(i => i.id === excludeId) : null;
    const urlUnchanged = editingItem && editingItem.url === data.url;
    if (!urlUnchanged) {
        // Reject anything that is not a plausible http(s) URL / prefix pattern - garbage that could
        // never match a real tab. Inside the urlUnchanged guard (like the checks below), so a
        // legacy/imported invalid rule can still have its other (non-URL) fields edited.
        if (!isValidSchedulePattern(data.url)) {
            return t('invalid_schedule_url');
        }
        // Two policies, exact-duplicate first (it wins the message regardless of list position):
        //  1. Exact duplicate on the NORMALIZED url (protocol/www/case-insensitive) - existing behavior.
        //  2. Strict pattern OVERLAP on the RAW url, matching the runtime exact-or-prefix grammar, so a
        //     wildcard rule that would refresh the same page(s) as another rule is refused too.
        const normalizedUrl = normalizeUrl(data.url);
        let overlapItem = null;
        for (const item of list) {
            if (excludeId && item.id === excludeId) continue;
            if (normalizeUrl(item.url) === normalizedUrl) {
                return t('duplicate_schedule_url');
            }
            if (!overlapItem && schedulePatternsOverlap(data.url, item.url)) {
                overlapItem = item;
            }
        }
        if (overlapItem) {
            // Substitute {url} with a callback because replacement strings interpret $&, $', $`,
            // and $n in a raw URL as special patterns and could corrupt the displayed value.
            return t('overlapping_schedule_url').replace('{url}', () => overlapItem.url);
        }
    }

    // The schedule-count limit is enforced only when adding a new rule
    if (!excludeId && list.length >= MAX_SCHEDULES) {
        return t('max_schedules_reached').replace('{max}', MAX_SCHEDULES);
    }

    return null;
}

/**
 * Open the schedule modal in add mode; on confirm, append a new rule (with a
 * timestamp-based id and the chosen url/interval/enabled/refreshMode/jitterMode/recoverMode) to
 * the global settings, persist+apply, reset to page 1, and re-render. (The modal itself requests
 * the webNavigation permission when recoverMode is set to 'on', reverting to 'default' on denial.)
 * @returns {Promise<void>}
 */
async function openAddScheduleModal() {
    const result = await openScheduleModal({
        isEdit: false,
        initial: { url: '', interval: 300, enabled: true, refreshMode: 'default', jitterMode: 'default', recoverMode: 'default' },
        validate: (data) => validateScheduleData(data, null),
    });
    if (!result) return;

    let currentSettings = getGlobalSettings();
    if (!currentSettings.scheduledRefreshes) {
        currentSettings.scheduledRefreshes = [];
    }
    currentSettings.scheduledRefreshes.push({
        id: Date.now().toString(),
        url: result.url,
        interval: result.interval,
        enabled: result.enabled,
        refreshMode: result.refreshMode,
        jitterMode: result.jitterMode,
        recoverMode: result.recoverMode,
    });
    setGlobalSettings(currentSettings);
    saveAndApplyGlobalSettings();
    currentSchedulePage = 1; // Reset to the first page
    refreshAfterMutation();
}

/**
 * Open the schedule modal in edit mode for the rule with the given id; on confirm,
 * merge the edited url/interval/enabled/refreshMode/jitterMode/recoverMode back into the existing
 * rule, persist+apply, and re-render. No-op if the id is not found.
 * @param {string} id - The id of the scheduled-refresh rule to edit.
 * @returns {Promise<void>}
 */
async function openEditScheduleModal(id) {
    const currentSettings = getGlobalSettings();
    const item = (currentSettings.scheduledRefreshes || []).find(i => i.id === id);
    if (!item) return;

    const result = await openScheduleModal({
        isEdit: true,
        initial: {
            url: item.url,
            interval: item.interval,
            enabled: item.enabled,
            refreshMode: item.refreshMode || 'default',
            jitterMode: item.jitterMode || 'default',
            recoverMode: item.recoverMode || 'default',
        },
        validate: (data) => validateScheduleData(data, id),
    });
    if (!result) return;

    let settings = getGlobalSettings();
    const itemIndex = settings.scheduledRefreshes.findIndex(i => i.id === id);
    if (itemIndex > -1) {
        settings.scheduledRefreshes[itemIndex] = {
            ...settings.scheduledRefreshes[itemIndex],
            url: result.url,
            interval: result.interval,
            enabled: result.enabled,
            refreshMode: result.refreshMode,
            jitterMode: result.jitterMode,
            recoverMode: result.recoverMode,
        };
        setGlobalSettings(settings);
        saveAndApplyGlobalSettings();
        refreshAfterMutation();
    }
}

/**
 * Handle input in the search box: trim the query, run a search and show the clear
 * button when non-empty, otherwise clear the search.
 * @param {Event} e - The input event from the search field.
 */
function handleSearchInput(e) {
    const query = e.target.value.trim();
    currentSearchQuery = query;

    if (query) {
        performSearch(query);
        if (clearSearchBtn) clearSearchBtn.style.display = 'block';
    } else {
        clearSearch();
    }
}

/**
 * Filter the schedules by URL substring against the current settings, reset to page 1,
 * re-render, and update the search-results info line.
 * @param {string} query - The search query (case-insensitive URL substring).
 */
function performSearch(query) {
    const currentSettings = getGlobalSettings();
    allSchedules = currentSettings.scheduledRefreshes || [];

    // Filter schedules by URL
    filteredSchedules = allSchedules.filter(schedule =>
        schedule.url.toLowerCase().includes(query.toLowerCase())
    );

    currentSchedulePage = 1; // Reset to the first page when searching
    renderScheduledRefreshes();
    updateSearchResultsInfo(query, filteredSchedules.length, allSchedules.length);
}

/**
 * Clear the active search: reset the input and query state, hide the clear button and
 * search-results info, reset to page 1, and re-render the full list.
 * @returns {void}
 */
function clearSearch() {
    if (schedulesSearchInput) schedulesSearchInput.value = '';
    if (clearSearchBtn) clearSearchBtn.style.display = 'none';
    if (searchResultsInfo) searchResultsInfo.style.display = 'none';

    currentSearchQuery = '';
    filteredSchedules = [];
    currentSchedulePage = 1;
    renderScheduledRefreshes();
}

/**
 * Render the search-results info line: a "no results" message when nothing matched,
 * otherwise a localized "found N of M" summary.
 * @param {string} query - The search query (used in the no-results message).
 * @param {number} foundCount - Number of matching schedules.
 * @param {number} totalCount - Total number of schedules.
 */
function updateSearchResultsInfo(query, foundCount, totalCount) {
    if (!searchResultsInfo) return;

    if (foundCount === 0) {
        searchResultsInfo.textContent = t('no_search_results').replace('{query}', query);
    } else {
        searchResultsInfo.textContent = t('search_results')
            .replace('{count}', foundCount)
            .replace('{total}', totalCount);
    }
    searchResultsInfo.style.display = 'block';
}

/**
 * Return the schedules to display, NEWEST-first: the filtered subset when a search is active,
 * otherwise the full list, reversed on a COPY. New rules are appended to storage, so reversing
 * shows the latest additions on top while editing a rule leaves its stored position unchanged.
 *
 * The .slice() is required: this accessor is called several times per render/pagination cycle,
 * so an in-place .reverse() on the shared view array (allSchedules / filteredSchedules) would
 * flip it back and forth between calls. (Stored order is safe regardless - getGlobalSettings
 * returns a deep copy - but the view arrays are reused.)
 * @returns {Object[]} A newest-first copy of the schedules currently being displayed.
 */
function getDisplaySchedules() {
    return (currentSearchQuery ? filteredSchedules : allSchedules).slice().reverse();
}

/**
 * Render the scheduled-refresh list into the DOM: refresh the count badge, show an
 * empty/no-results placeholder when there is nothing to show, otherwise render the
 * current page's rules (each with url, interval/mode/jitter/recover/status meta line, and
 * toggle/edit/delete actions) plus pagination when the count exceeds one page. When no
 * search is active it rebuilds allSchedules from the current settings; under an active
 * search it leaves the filtered subset intact.
 * @returns {void}
 */
export function renderScheduledRefreshes() {
    // Re-fetch the element if it isn't set
    if (!scheduledListUl) {
        scheduledListUl = document.getElementById('scheduled-list-ul');
    }

    if (!scheduledListUl) {
        console.warn('scheduledListUl not found! The scheduled-list-ul element is missing from the DOM');
        // At least try to refresh the counter
        forceUpdateCounter();
        return;
    }

    scheduledListUl.innerHTML = '';
    const currentSettings = getGlobalSettings();

    // Prepare the schedules (all, or the filtered subset)
    if (!currentSearchQuery) {
        allSchedules = currentSettings.scheduledRefreshes || [];
        filteredSchedules = [];
    }

    const displaySchedules = getDisplaySchedules();
    const displayTotal = displaySchedules.length;

    // Force a counter refresh
    forceUpdateCounter();

    if (displayTotal === 0) {
        const li = document.createElement('li');
        li.className = 'no-schedules';
        if (currentSearchQuery) {
            li.textContent = t('no_search_results').replace('{query}', currentSearchQuery);
        } else {
            li.textContent = t('no_schedules');
        }
        scheduledListUl.appendChild(li);
        hideSchedulesPagination();
        return;
    }

    // Show pagination when there are more than schedulesPerPage entries
    if (displayTotal > schedulesPerPage) {
        showSchedulesPagination();
        renderSchedulesPagination();
    } else {
        hideSchedulesPagination();
    }

    // Compute the slice range for the current page
    const startIndex = (currentSchedulePage - 1) * schedulesPerPage;
    const endIndex = Math.min(startIndex + schedulesPerPage, displayTotal);
    const pageSchedules = displaySchedules.slice(startIndex, endIndex);

    pageSchedules.forEach(item => {
        const li = document.createElement('li');
        li.dataset.id = item.id;
        const detailsDiv = document.createElement('div');
        detailsDiv.className = 'scheduled-item-details';

        const intervalText = formatIntervalLong(item.interval);

        // Escape the URL first, then highlight the matched text on the already-safe
        // string. This way a user-supplied URL cannot inject HTML (XSS), and <mark> is
        // added only by our own code on top of the escaped text.
        const safeUrl = escapeHtml(item.url);
        let displayUrl = safeUrl;
        if (currentSearchQuery) {
            const safeQuery = escapeHtml(currentSearchQuery);
            const regex = new RegExp(`(${safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            displayUrl = safeUrl.replace(regex, '<mark>$1</mark>');
        }

        const urlDiv = document.createElement('div');
        urlDiv.className = 'url';
        urlDiv.title = item.url;  // Auto-escaped: property assignment, not HTML parsing
        urlDiv.innerHTML = displayUrl;  // escaped text + our own <mark> only

        const metaDiv = document.createElement('div');
        metaDiv.className = 'meta';

        const intervalSpan = document.createElement('span');
        intervalSpan.className = 'interval';
        intervalSpan.textContent = intervalText;

        const modeSpan = document.createElement('span');
        modeSpan.className = 'refresh-mode-badge';
        modeSpan.textContent = refreshModeLabel(item.refreshMode);

        const jitterSpan = document.createElement('span');
        jitterSpan.className = 'jitter-mode-badge';
        jitterSpan.textContent = jitterModeLabel(item.jitterMode);

        const recoverSpan = document.createElement('span');
        recoverSpan.className = 'recover-mode-badge';
        recoverSpan.textContent = recoverModeLabel(item.recoverMode);

        const statusSpan = document.createElement('span');
        statusSpan.className = `status ${item.enabled ? 'enabled' : 'disabled'}`;
        statusSpan.textContent = item.enabled ? t('status_enabled') : t('status_disabled');

        // The " | " separators between segments are drawn in CSS
        // (.meta > span:not(:last-child)::after), so each segment wraps as a whole
        // unit and a wrapped line never starts with a stray separator.
        metaDiv.appendChild(intervalSpan);
        metaDiv.appendChild(modeSpan);
        metaDiv.appendChild(jitterSpan);
        metaDiv.appendChild(recoverSpan);
        metaDiv.appendChild(statusSpan);

        detailsDiv.appendChild(urlDiv);
        detailsDiv.appendChild(metaDiv);
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'scheduled-item-actions';
        const toggleButton = document.createElement('button');
        toggleButton.textContent = item.enabled ? t('disable') : t('enable');
        toggleButton.className = 'toggle-scheduled-item';
        toggleButton.addEventListener('click', () => toggleScheduledItem(item.id));
        const editButton = document.createElement('button');
        editButton.textContent = t('edit');
        editButton.className = 'edit-scheduled-item';
        editButton.addEventListener('click', () => openEditScheduleModal(item.id));
        const deleteButton = document.createElement('button');
        deleteButton.textContent = t('delete');
        deleteButton.className = 'delete-scheduled-item';
        deleteButton.addEventListener('click', () => deleteScheduledItem(item.id));
        actionsDiv.appendChild(toggleButton);
        actionsDiv.appendChild(editButton);
        actionsDiv.appendChild(deleteButton);
        li.appendChild(detailsDiv);
        li.appendChild(actionsDiv);
        scheduledListUl.appendChild(li);
    });
}

/**
 * Rebuild allSchedules/filteredSchedules from fresh settings without resetting page or rendering.
 * Used by refreshAfterMutation so an active search filter does not keep stale entries.
 * @returns {number} Number of displayed schedules after rebuilding view data.
 */
function rebuildScheduleViewData() {
    const currentSettings = getGlobalSettings();
    allSchedules = currentSettings.scheduledRefreshes || [];
    filteredSchedules = currentSearchQuery
        ? allSchedules.filter(s => s.url.toLowerCase().includes(currentSearchQuery.toLowerCase()))
        : [];
    return getDisplaySchedules().length;
}

/**
 * Reconcile the list view after a create/edit/toggle/delete mutation: rebuild the view data from
 * fresh settings, clamp the current page to the new displayed range (so removing the only match on
 * the last page cannot strand a blank view), re-render, refresh the search-results info while a
 * search is active, and update the counter. This is the shared reconciliation path for every CRUD mutation.
 * @returns {void}
 */
function refreshAfterMutation() {
    // Clamp against the DISPLAYED count (the filtered subset while searching), not the full list;
    // Math.max(1, ...) resets to page 1 when the list is emptied (totalPages === 0).
    const displayTotal = rebuildScheduleViewData();
    const totalPages = Math.ceil(displayTotal / schedulesPerPage);
    if (currentSchedulePage > totalPages) {
        currentSchedulePage = Math.max(1, totalPages);
    }
    renderScheduledRefreshes();
    if (currentSearchQuery) {
        updateSearchResultsInfo(currentSearchQuery, filteredSchedules.length, allSchedules.length);
    }
    forceUpdateCounter();
}

/**
 * Toggle the enabled state of the rule with the given id, persist+apply, then reconcile the view.
 * No-op if the id is not found.
 * @param {string} id - The id of the scheduled-refresh rule to toggle.
 * @returns {void}
 */
function toggleScheduledItem(id) {
    let currentSettings = getGlobalSettings();
    const itemIndex = currentSettings.scheduledRefreshes.findIndex(i => i.id === id);
    if (itemIndex > -1) {
        currentSettings.scheduledRefreshes[itemIndex].enabled = !currentSettings.scheduledRefreshes[itemIndex].enabled;
        setGlobalSettings(currentSettings);
        saveAndApplyGlobalSettings();
        refreshAfterMutation();
    }
}

/**
 * Ask for confirmation, then delete the rule with the given id and reconcile the view if confirmed.
 * @param {string} id - The id of the scheduled-refresh rule to delete.
 * @returns {Promise<void>}
 */
async function deleteScheduledItem(id) {
    const confirmed = await showConfirm(
        t('delete_schedule_confirm'),
        t('delete_schedule_title'),
        { type: 'danger', confirmText: t('delete'), cancelText: t('cancel') }
    );
    if (confirmed) {
        let currentSettings = getGlobalSettings();
        currentSettings.scheduledRefreshes = currentSettings.scheduledRefreshes.filter(i => i.id !== id);
        setGlobalSettings(currentSettings);
        saveAndApplyGlobalSettings();
        refreshAfterMutation();
    }
}

/**
 * Navigate to the given 1-based page of the displayed schedules and re-render.
 * No-op if the page is out of range.
 * @param {number} page - The target page number (1-based).
 * @returns {void}
 */
function goToSchedulePage(page) {
    const displaySchedules = getDisplaySchedules();
    const totalPages = Math.ceil(displaySchedules.length / schedulesPerPage);
    if (page < 1 || page > totalPages) return;

    currentSchedulePage = page;
    renderScheduledRefreshes();
}

/**
 * Render the pagination control for the schedules list: the "showing N of M" info line,
 * the enabled/disabled state of the first/prev/next/last buttons, and the windowed page
 * number buttons (up to 5 visible, with leading/trailing ellipses and first/last shortcuts).
 * @returns {void}
 */
function renderSchedulesPagination() {
    if (!schedulesPaginationContainer || !schedulesPaginationInfoText || !schedulesPaginationPages) return;

    const displaySchedules = getDisplaySchedules();
    const displayTotal = displaySchedules.length;
    const totalPages = Math.ceil(displayTotal / schedulesPerPage);
    const startItem = (currentSchedulePage - 1) * schedulesPerPage + 1;
    const endItem = Math.min(currentSchedulePage * schedulesPerPage, displayTotal);

    // Update the pagination info line
    const paginationKey = currentSearchQuery ? 'pagination_shown_schedules_found' : 'pagination_shown_schedules';
    schedulesPaginationInfoText.textContent = t(paginationKey)
        .replace('{start}', startItem)
        .replace('{end}', endItem)
        .replace('{total}', displayTotal);

    // Update the navigation buttons' enabled/disabled state
    if (schedulesPaginationFirstBtn) schedulesPaginationFirstBtn.disabled = currentSchedulePage === 1;
    if (schedulesPaginationPrevBtn) schedulesPaginationPrevBtn.disabled = currentSchedulePage === 1;
    if (schedulesPaginationNextBtn) schedulesPaginationNextBtn.disabled = currentSchedulePage === totalPages;
    if (schedulesPaginationLastBtn) schedulesPaginationLastBtn.disabled = currentSchedulePage === totalPages;

    // Clear and rebuild the page number buttons
    schedulesPaginationPages.innerHTML = '';

    // Page-number display logic
    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentSchedulePage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

    // Adjust if there aren't enough pages at the end
    if (endPage - startPage + 1 < maxVisiblePages) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    // Add the first page and an ellipsis if needed
    if (startPage > 1) {
        addSchedulePageButton(1);
        if (startPage > 2) {
            addScheduleEllipsis();
        }
    }

    // Add the visible pages
    for (let i = startPage; i <= endPage; i++) {
        addSchedulePageButton(i);
    }

    // Add an ellipsis and the last page if needed
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            addScheduleEllipsis();
        }
        addSchedulePageButton(totalPages);
    }
}

/**
 * Append a clickable page-number button to the pagination control, marking it active
 * when it matches the current page.
 * @param {number} pageNum - The page number this button navigates to.
 * @returns {void}
 */
function addSchedulePageButton(pageNum) {
    const button = document.createElement('button');
    button.className = `pagination-page ${pageNum === currentSchedulePage ? 'active' : ''}`;
    button.textContent = pageNum;
    button.addEventListener('click', () => goToSchedulePage(pageNum));
    schedulesPaginationPages.appendChild(button);
}

/**
 * Append a non-clickable "..." ellipsis span to the pagination control.
 * @returns {void}
 */
function addScheduleEllipsis() {
    const ellipsis = document.createElement('span');
    ellipsis.className = 'pagination-ellipsis';
    ellipsis.textContent = '...';
    schedulesPaginationPages.appendChild(ellipsis);
}

/**
 * Show the schedules pagination container (display: flex).
 * @returns {void}
 */
function showSchedulesPagination() {
    if (schedulesPaginationContainer) {
        schedulesPaginationContainer.style.display = 'flex';
    }
}

/**
 * Hide the schedules pagination container (display: none).
 * @returns {void}
 */
function hideSchedulesPagination() {
    if (schedulesPaginationContainer) {
        schedulesPaginationContainer.style.display = 'none';
    }
}

/**
 * Delegate schedule-counter updates to the global counter helper installed by settings.js.
 * @returns {void}
 */
function updateSchedulesCounter() {
    if (window.updateSchedulesCounterGlobal) {
        window.updateSchedulesCounterGlobal();
    }
}

/**
 * Queue a schedule-counter refresh shortly after rendering so DOM changes settle first.
 * @returns {void}
 */
function forceUpdateCounter() {
    setTimeout(updateSchedulesCounter, 100);
}
