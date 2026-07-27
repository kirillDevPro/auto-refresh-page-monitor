// Settings page: Activity Log tab. Loads activity entries from chrome.storage.local,
// prunes entries older than 7 days, filters by a selected date period, paginates and
// renders them, updates the count/date-range summary, and exports the filtered set as
// a downloadable JSON file.
import { showToast, showConfirm } from './modal.js';
import { escapeHtml } from './htmlUtils.js';
import { t, getCurrentLanguage } from './chromeI18n.js';

/**
 * Returns the active UI language as a BCP-47 locale tag, converting Chrome's
 * underscore code (e.g. zh_CN) to hyphenated form (zh-CN) for Intl/toLocale* APIs.
 * @returns {string} The normalized BCP-47 locale tag.
 */
function uiLocale() {
    return getCurrentLanguage().replace('_', '-');
}

// DOM Elements that this module will need (passed during setup)
let logContainer, clearLogButtonElement, logDateFilter, refreshLogButton, exportLogButton;
let logCountElement, logDateRangeElement;

// Pagination state for the logs
let currentLogPage = 1;
let logsPerPage = 50; // Show 50 log entries per page
let totalLogs = 0;
let allFilteredLogs = [];

// Log pagination DOM elements
let logPaginationContainer, logPaginationInfoText, logPaginationPages;
let logPaginationFirstBtn, logPaginationPrevBtn, logPaginationNextBtn, logPaginationLastBtn;

/**
 * Wires up the Activity Log UI: caches DOM element references, resolves the
 * date-filter, refresh/export buttons and pagination controls, attaches event
 * listeners, and performs the initial log load.
 * @param {{logContainer: HTMLElement, clearLogButton: HTMLElement}} elements - Pre-resolved DOM references passed by the settings orchestrator.
 */
export function initializeActivityLogUI(elements) {
    logContainer = elements.logContainer;
    clearLogButtonElement = elements.clearLogButton;

    // Additional elements
    logDateFilter = document.getElementById('log-date-filter');
    refreshLogButton = document.getElementById('refresh-log');
    exportLogButton = document.getElementById('export-log');
    logCountElement = document.getElementById('log-count');
    logDateRangeElement = document.getElementById('log-date-range');
    
    // Log pagination elements
    logPaginationContainer = document.getElementById('log-pagination-container');
    logPaginationInfoText = document.getElementById('log-pagination-info-text');
    logPaginationPages = document.getElementById('log-pagination-pages');
    logPaginationFirstBtn = document.getElementById('log-pagination-first');
    logPaginationPrevBtn = document.getElementById('log-pagination-prev');
    logPaginationNextBtn = document.getElementById('log-pagination-next');
    logPaginationLastBtn = document.getElementById('log-pagination-last');

    setupEventListeners();
    loadActivityLog(); // Initial load
}

/**
 * Attaches click/change listeners for the clear-log, date-filter, refresh,
 * export and pagination (first/prev/next/last) controls. Each list-changing
 * action resets to page 1 and reloads the log.
 */
function setupEventListeners() {
    // Clear logs
    if (clearLogButtonElement) {
        clearLogButtonElement.addEventListener('click', async () => {
            const confirmed = await showConfirm(
                t('clear_log_confirm'),
                t('clear_log'),
                { type: 'danger', confirmText: t('clear'), cancelText: t('cancel') }
            );
            if (confirmed) {
                await chrome.storage.local.set({ activityLogs: [] });
                currentLogPage = 1; // Reset to the first page
                loadActivityLog(); // Reload to show empty log
                showNotification(t('log_cleared'), 'success');
            }
        });
    }

    // Date filter
    if (logDateFilter) {
        logDateFilter.addEventListener('change', () => {
            currentLogPage = 1; // Reset to the first page
            loadActivityLog();
        });
    }

    // Refresh logs
    if (refreshLogButton) {
        refreshLogButton.addEventListener('click', () => {
            currentLogPage = 1; // Reset to the first page
            loadActivityLog();
        });
    }

    // Export logs
    if (exportLogButton) {
        exportLogButton.addEventListener('click', exportLogs);
    }
    
    // Log pagination
    if (logPaginationFirstBtn) {
        logPaginationFirstBtn.addEventListener('click', () => goToLogPage(1));
    }
    
    if (logPaginationPrevBtn) {
        logPaginationPrevBtn.addEventListener('click', () => goToLogPage(currentLogPage - 1));
    }
    
    if (logPaginationNextBtn) {
        logPaginationNextBtn.addEventListener('click', () => goToLogPage(currentLogPage + 1));
    }
    
    if (logPaginationLastBtn) {
        logPaginationLastBtn.addEventListener('click', () => goToLogPage(Math.ceil(totalLogs / logsPerPage)));
    }
}

/**
 * Loads activity logs from chrome.storage.local, prunes entries older than 7 days
 * (persisting the pruned array if anything was removed), filters by the selected
 * period, updates the count/date-range summary, and renders the paginated list.
 * On failure logs the error and shows an error toast.
 * @returns {Promise<void>}
 */
export async function loadActivityLog() {
    if (!logContainer) return;

    try {
        const { activityLogs = [] } = await chrome.storage.local.get('activityLogs');

        // Prune old logs (older than 7 days)
        const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const cleanedLogs = activityLogs.filter(log => log.timestamp >= weekAgo);

        // Persist the pruned logs if anything was removed
        if (cleanedLogs.length !== activityLogs.length) {
            await chrome.storage.local.set({ activityLogs: cleanedLogs });
        }

        // Filter logs by the selected period
        allFilteredLogs = filterLogsByPeriod(cleanedLogs);
        totalLogs = allFilteredLogs.length;

        // Update the summary stats
        updateLogStats(allFilteredLogs);

        // Render the logs with pagination
        renderLogs();
        
    } catch (error) {
        console.error('Error loading activity log:', error);
        showNotification(t('log_load_error'), 'error');
    }
}

/**
 * Filters a log array by the date-filter <select> value: 'today', 'yesterday',
 * '3' (last 3 days), '7' (last 7 days), or 'all'/default (no filtering).
 * 'yesterday' returns only entries within that single calendar day.
 * @param {Array<{timestamp: number}>} logs - The logs to filter.
 * @returns {Array<{timestamp: number}>} The filtered logs.
 */
function filterLogsByPeriod(logs) {
    if (!logDateFilter) return logs;
    
    const filterValue = logDateFilter.value;
    const now = new Date();
    let cutoffTime;
    
    switch (filterValue) {
        case 'today':
            cutoffTime = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            break;
        case 'yesterday':
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            cutoffTime = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()).getTime();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            return logs.filter(log => log.timestamp >= cutoffTime && log.timestamp < todayStart);
        case '3':
            cutoffTime = now.getTime() - (3 * 24 * 60 * 60 * 1000);
            break;
        case '7':
            cutoffTime = now.getTime() - (7 * 24 * 60 * 60 * 1000);
            break;
        case 'all':
        default:
            return logs;
    }
    
    return logs.filter(log => log.timestamp >= cutoffTime);
}

/**
 * Updates the entry-count label and the date-range label (a single date when all
 * entries fall on one day, otherwise oldest - newest, both localized; or a
 * "no data" placeholder when the list is empty).
 * @param {Array<{timestamp: number}>} logs - The filtered logs to summarize.
 */
function updateLogStats(logs) {
    if (logCountElement) {
        const count = logs.length;
        logCountElement.textContent = t('log_entries_count').replace('{count}', count);
    }

    if (logDateRangeElement && logs.length > 0) {
        const loc = uiLocale();
        const oldest = new Date(Math.min(...logs.map(log => log.timestamp)));
        const newest = new Date(Math.max(...logs.map(log => log.timestamp)));

        if (oldest.toDateString() === newest.toDateString()) {
            logDateRangeElement.textContent = oldest.toLocaleDateString(loc);
        } else {
            logDateRangeElement.textContent = `${oldest.toLocaleDateString(loc)} - ${newest.toLocaleDateString(loc)}`;
        }
    } else if (logDateRangeElement) {
        logDateRangeElement.textContent = t('log_no_data');
    }
}

/**
 * Renders the current page of filtered logs into logContainer (newest first),
 * showing or hiding the pagination controls based on whether the total exceeds
 * logsPerPage, and applying error/success/warning CSS classes by message content.
 */
function renderLogs() {
    logContainer.innerHTML = ''; // Clear previous logs
    
    if (totalLogs === 0) {
        logContainer.innerHTML = `<p>${escapeHtml(t('log_no_entries'))}</p>`;
        hideLogPagination();
        return;
    }
    
    // Show pagination when there are more than logsPerPage entries
    if (totalLogs > logsPerPage) {
        showLogPagination();
        renderLogPagination();
    } else {
        hideLogPagination();
    }
    
    // Sort logs by time (newest first)
    const sortedLogs = allFilteredLogs.sort((a, b) => b.timestamp - a.timestamp);

    // Compute the slice range for the current page
    const startIndex = (currentLogPage - 1) * logsPerPage;
    const endIndex = Math.min(startIndex + logsPerPage, totalLogs);
    const pageLogs = sortedLogs.slice(startIndex, endIndex);
    
    pageLogs.forEach(log => {
        const p = document.createElement('p');
        const date = new Date(log.timestamp);
        
        // Determine the log type for styling
        let logClass = '';
        if (log.message.toLowerCase().includes('error') || log.message.toLowerCase().includes('failed')) {
            logClass = 'log-error';
        } else if (log.message.toLowerCase().includes('success') || log.message.toLowerCase().includes('completed')) {
            logClass = 'log-success';
        } else if (log.message.toLowerCase().includes('warning') || log.message.toLowerCase().includes('paused')) {
            logClass = 'log-warning';
        }
        
        if (logClass) {
            p.className = logClass;
        }
        
        // Format the log entry content
        const timestamp = date.toLocaleString(uiLocale());
        const tabId = log.tabId !== undefined ? log.tabId : 'N/A';
        
        p.innerHTML = `
            <span class="log-timestamp">[${escapeHtml(timestamp)}]</span>
            <span class="log-tab">(Tab ${escapeHtml(String(tabId))}):</span>
            <span class="log-message">${escapeHtml(log.message)}</span>
        `;
        
        logContainer.appendChild(p);
    });
}

/**
 * Exports the period-filtered logs as a downloadable JSON file (timestamps as ISO
 * strings, plus export date, period label, total count and a version field).
 * Shows a warning toast when there is nothing to export and an error toast on failure.
 * @returns {Promise<void>}
 */
async function exportLogs() {
    try {
        const { activityLogs = [] } = await chrome.storage.local.get('activityLogs');
        const filteredLogs = filterLogsByPeriod(activityLogs);
        
        if (filteredLogs.length === 0) {
            showNotification(t('log_no_export'), 'warning');
            return;
        }
        
        const exportData = {
            logs: filteredLogs.map(log => ({
                timestamp: new Date(log.timestamp).toISOString(),
                tabId: log.tabId,
                message: log.message
            })),
            exportDate: new Date().toISOString(),
            period: logDateFilter ? logDateFilter.options[logDateFilter.selectedIndex].text : t('all_time'),
            totalEntries: filteredLogs.length,
            version: '1.0.0'
        };
        
        const dataStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `pages-auto-updater-logs-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showNotification(t('log_exported'), 'success');
    } catch (error) {
        console.error('Error exporting logs:', error);
        showNotification(t('log_export_error'), 'error');
    }
}

// Helper functions
/**
 * Thin wrapper around showToast for activity-log notifications.
 * @param {string} message - The message to display.
 * @param {string} [type='info'] - Toast type ('info' | 'success' | 'warning' | 'error').
 */
function showNotification(message, type = 'info') {
    showToast(message, type);
}

// Log pagination functions
/**
 * Navigates to the given page and re-renders the logs. Out-of-range requests
 * (page < 1 or page > totalPages) are ignored, not clamped.
 * @param {number} page - The target page number.
 */
function goToLogPage(page) {
    const totalPages = Math.ceil(totalLogs / logsPerPage);
    if (page < 1 || page > totalPages) return;
    
    currentLogPage = page;
    renderLogs();
}

/**
 * Renders the pagination info text and page-number buttons: updates the
 * "showing X-Y of Z" label, enables/disables the first/prev/next/last buttons,
 * and builds a windowed (max 5) set of page buttons with leading/trailing
 * first/last buttons and ellipses as needed.
 */
function renderLogPagination() {
    if (!logPaginationContainer || !logPaginationInfoText || !logPaginationPages) return;
    
    const totalPages = Math.ceil(totalLogs / logsPerPage);
    const startItem = (currentLogPage - 1) * logsPerPage + 1;
    const endItem = Math.min(currentLogPage * logsPerPage, totalLogs);
    
    // Update the pagination info text
    logPaginationInfoText.textContent = t('pagination_shown_entries')
        .replace('{start}', startItem)
        .replace('{end}', endItem)
        .replace('{total}', totalLogs);
    
    // Update the navigation buttons' enabled/disabled state
    if (logPaginationFirstBtn) logPaginationFirstBtn.disabled = currentLogPage === 1;
    if (logPaginationPrevBtn) logPaginationPrevBtn.disabled = currentLogPage === 1;
    if (logPaginationNextBtn) logPaginationNextBtn.disabled = currentLogPage === totalPages;
    if (logPaginationLastBtn) logPaginationLastBtn.disabled = currentLogPage === totalPages;
    
    // Clear and rebuild the page-number buttons
    logPaginationPages.innerHTML = '';

    // Page-number window logic
    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentLogPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    
    // Adjust when there are not enough pages at the end
    if (endPage - startPage + 1 < maxVisiblePages) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }
    
    // Add the first page and a leading ellipsis if needed
    if (startPage > 1) {
        addLogPageButton(1);
        if (startPage > 2) {
            addLogEllipsis();
        }
    }
    
    // Add the visible page buttons
    for (let i = startPage; i <= endPage; i++) {
        addLogPageButton(i);
    }
    
    // Add a trailing ellipsis and the last page if needed
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            addLogEllipsis();
        }
        addLogPageButton(totalPages);
    }
}

/**
 * Appends a clickable page-number button to the pagination bar, marking it
 * 'active' when it is the current page.
 * @param {number} pageNum - The page number this button navigates to.
 */
function addLogPageButton(pageNum) {
    const button = document.createElement('button');
    button.className = `pagination-page ${pageNum === currentLogPage ? 'active' : ''}`;
    button.textContent = pageNum;
    button.addEventListener('click', () => goToLogPage(pageNum));
    logPaginationPages.appendChild(button);
}

/**
 * Appends a non-interactive ellipsis ("...") separator to the pagination bar.
 */
function addLogEllipsis() {
    const ellipsis = document.createElement('span');
    ellipsis.className = 'pagination-ellipsis';
    ellipsis.textContent = '...';
    logPaginationPages.appendChild(ellipsis);
}

/**
 * Makes the pagination container visible (display: flex).
 */
function showLogPagination() {
    if (logPaginationContainer) {
        logPaginationContainer.style.display = 'flex';
    }
}

/**
 * Hides the pagination container (display: none).
 */
function hideLogPagination() {
    if (logPaginationContainer) {
        logPaginationContainer.style.display = 'none';
    }
}
