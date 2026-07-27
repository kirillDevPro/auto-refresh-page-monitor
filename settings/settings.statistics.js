// settings.statistics.js - Main module for managing the statistics dashboard

import { showToast, showConfirm } from './modal.js';
import { formatIntervalShort } from './timeFormat.js';
import { t, getCurrentLanguage } from './chromeI18n.js';
import { escapeHtml } from './htmlUtils.js';

/**
 * Returns the active UI language as a BCP-47 locale tag.
 * Chrome's underscore-form codes (zh_CN, pt_PT) are converted to the
 * dash form (zh-CN, pt-PT) expected by Intl/toLocaleString APIs.
 * @returns {string} BCP-47 locale tag.
 */
function uiLocale() {
    return getCurrentLanguage().replace('_', '-');
}

let statisticsData = null;

// Pagination
let currentPage = 1;
let itemsPerPage = 10;
let totalItems = 0;
let allUrls = [];

// Sorting
let currentSortColumn = 'refreshes'; // Default: sort by number of refreshes
let currentSortDirection = 'desc'; // Default: descending

// DOM elements
let totalRefreshesEl, averageIntervalEl, uniqueUrlsEl;
let refreshesChangeEl, intervalTrendEl, urlsChangeEl;
let storageUsageTextEl; // Element for the storage-usage text
let exportStatisticsBtn, resetStatisticsBtn;
let urlsTableBody;

// Pagination elements
let paginationContainer, paginationInfoText, paginationPages;
let paginationFirstBtn, paginationPrevBtn, paginationNextBtn, paginationLastBtn;

/**
 * Initializes the statistics dashboard: caches DOM elements, wires up
 * event listeners (export/reset/pagination/sorting), and loads statistics.
 */
export function initializeStatisticsUI() {
    initializeDOMElements();
    setupEventListeners();
    loadStatistics();
}

/**
 * Caches references to all statistics-page DOM elements (summary cards,
 * change indicators, control buttons, URL table body, pagination controls).
 */
function initializeDOMElements() {
    // Statistics cards
    totalRefreshesEl = document.getElementById('total-refreshes');
    averageIntervalEl = document.getElementById('average-interval');
    uniqueUrlsEl = document.getElementById('unique-urls');
    storageUsageTextEl = document.getElementById('storage-usage-text');

    // Change indicators
    refreshesChangeEl = document.getElementById('refreshes-change');
    intervalTrendEl = document.getElementById('interval-trend');
    urlsChangeEl = document.getElementById('urls-change');
    
    // Control buttons
    exportStatisticsBtn = document.getElementById('export-statistics');
    resetStatisticsBtn = document.getElementById('reset-statistics');
    
    // URL table
    urlsTableBody = document.getElementById('urls-table-body');

    // Pagination elements
    paginationContainer = document.getElementById('pagination-container');
    paginationInfoText = document.getElementById('pagination-info-text');
    paginationPages = document.getElementById('pagination-pages');
    paginationFirstBtn = document.getElementById('pagination-first');
    paginationPrevBtn = document.getElementById('pagination-prev');
    paginationNextBtn = document.getElementById('pagination-next');
    paginationLastBtn = document.getElementById('pagination-last');
}

/**
 * Attaches click handlers for the export and reset buttons, the four
 * pagination navigation buttons, and initializes table-header sorting.
 */
function setupEventListeners() {
    // The period-selection controls were removed, so their handlers are no longer needed.

    // Export statistics
    if (exportStatisticsBtn) {
        exportStatisticsBtn.addEventListener('click', exportStatistics);
    }

    // Reset statistics
    if (resetStatisticsBtn) {
        resetStatisticsBtn.addEventListener('click', resetStatistics);
    }

    // Pagination
    if (paginationFirstBtn) {
        paginationFirstBtn.addEventListener('click', () => goToPage(1));
    }
    
    if (paginationPrevBtn) {
        paginationPrevBtn.addEventListener('click', () => goToPage(currentPage - 1));
    }
    
    if (paginationNextBtn) {
        paginationNextBtn.addEventListener('click', () => goToPage(currentPage + 1));
    }
    
    if (paginationLastBtn) {
        paginationLastBtn.addEventListener('click', () => goToPage(Math.ceil(totalItems / itemsPerPage)));
    }
    
    // Initialize table-header sorting
    setupTableSorting();
}

// Request to the background with retry. Right after a service-worker cold start, or its replacement
// on extension update, chrome.runtime.sendMessage may reject ('Could not establish connection' /
// 'Extension context invalidated') or return {status:'error'}. Without retry a single such failure
// painted a permanent "Error" (showErrorState) until the page was manually reloaded. We make several
// attempts with increasing backoff and only propagate the error once all are exhausted — then the
// dashboard recovers on its own as soon as the SW wakes up, with no user action.
// (Mirror of popup/utils.js sendMessageWithRetry — keep both copies in sync; popup and settings are
// deliberately separate trees, so shared code is not extracted.)
/**
 * Sends a message to the background with retry/backoff against service-worker
 * cold-start or replacement races. Treats an undefined response or a
 * {status:'error'} reply as a failure to be retried.
 * @param {object} message - The message to send to the background.
 * @param {{attempts?: number}} [options] - Max attempts (default 4).
 * @returns {Promise<object>} The successful background response.
 * @throws The last error if every attempt fails.
 */
async function sendStatsMessage(message, { attempts = 4 } = {}) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
        try {
            const response = await chrome.runtime.sendMessage(message);
            if (response === undefined) {
                throw new Error('No response from background (service worker likely starting)');
            }
            if (response.status === 'error') {
                throw new Error(response.message || 'Background returned an error');
            }
            return response;
        } catch (error) {
            lastError = error;
            if (i < attempts - 1) {
                const delayMs = Math.min(300 * Math.pow(3, i), 3000); // 300, 900, 2700ms
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    }
    throw lastError;
}

/**
 * Loads all-time statistics from the background (with retry), stores them in
 * the module-level cache, and renders the dashboard. Falls back to default
 * empty statistics if the response lacks data; shows an error state if every
 * retry fails.
 */
async function loadStatistics() {
    try {
        showLoadingState();

        // Fetch all-time statistics from the background (retry against the cold-start / SW-replacement race)
        const response = await sendStatsMessage({
            action: 'getStatistics',
            period: 'all'
        });

        statisticsData = (response && response.statistics) ? response.statistics : getDefaultStatistics();

        renderStatistics();
        hideLoadingState();
    } catch (error) {
        console.error('Error loading statistics:', error);
        hideLoadingState();
        showErrorState();
    }
}

/**
 * Renders the dashboard from the cached statisticsData: the summary cards and
 * the URL table. No-op if no statistics are loaded.
 */
function renderStatistics() {
    if (!statisticsData) return;

    renderGeneralStats();
    renderUrlsTable();
}

/**
 * Renders the summary cards: total refreshes, average interval, unique URLs,
 * the today/trend change indicators, and the storage-usage text.
 */
async function renderGeneralStats() {
    try {
        // Compute the summary statistics
        const summary = await calculateSummaryStatistics(statisticsData);

        // Total number of refreshes
        if (totalRefreshesEl) {
            totalRefreshesEl.textContent = summary.totalRefreshes.toLocaleString(uiLocale());
        }

        // Average interval
        if (averageIntervalEl) {
            averageIntervalEl.textContent = formatIntervalShort(summary.averageInterval);
        }
        
        // Unique URLs
        if (uniqueUrlsEl) {
            uniqueUrlsEl.textContent = summary.uniqueUrls.toLocaleString(uiLocale());
        }

        // Change indicators
        renderChanges(summary);

        // Storage usage
        if (storageUsageTextEl && summary.storageBytesUsed !== undefined && summary.storageQuotaBytes !== undefined) {
            const usedFormatted = formatBytes(summary.storageBytesUsed);
            const quotaFormatted = formatBytes(summary.storageQuotaBytes);
            const percentage = summary.storageQuotaBytes > 0 ? (summary.storageBytesUsed / summary.storageQuotaBytes * 100).toFixed(1) : 0;
            storageUsageTextEl.textContent = `${usedFormatted.value} ${usedFormatted.unit} / ${quotaFormatted.value} ${quotaFormatted.unit} (${percentage}%)`;
        }
        
    } catch (error) {
        console.error('Error rendering general stats:', error);
    }
}

/**
 * Formats a byte count into a human-readable value/unit pair.
 * @param {number} bytes - The byte count.
 * @param {number} [decimals=2] - Decimal places (negative is treated as 0).
 * @returns {{value: number, unit: string}} Scaled value and its unit (Bytes/KB/MB/GB/TB).
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return { value: 0, unit: 'Bytes' };
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return {
        value: parseFloat((bytes / Math.pow(k, i)).toFixed(dm)),
        unit: sizes[i]
    };
}

/**
 * Renders the per-card change indicators: today's refresh count, the (fixed)
 * interval trend, and today's unique-URL count.
 * @param {object} summary - The summary object from calculateSummaryStatistics.
 */
function renderChanges(summary) {
    // Show today's accumulated values instead of the difference from yesterday
    if (refreshesChangeEl) {
        const todayRefreshes = summary.todayRefreshes || 0;
        refreshesChangeEl.textContent = todayRefreshes > 0 ? t('stat_today').replace('{count}', todayRefreshes) : t('stat_no_activity');
        refreshesChangeEl.className = `stat-change ${todayRefreshes > 0 ? 'positive' : 'neutral'}`;
    }

    // Interval trend
    if (intervalTrendEl) {
        intervalTrendEl.textContent = t('stat_stable');
        intervalTrendEl.className = 'stat-change neutral';
    }

    // Unique URLs today
    if (urlsChangeEl) {
        const urlsToday = summary.todayUniqueUrls || 0;
        urlsChangeEl.textContent = urlsToday > 0 ? t('stat_today').replace('{count}', urlsToday) : t('stat_no_new');
        urlsChangeEl.className = `stat-change ${urlsToday > 0 ? 'positive' : 'neutral'}`;
    }
}

/**
 * Renders the per-URL statistics table for the current page: sorts all URLs,
 * shows an empty-state row when there is no data, manages pagination
 * visibility, slices the rows for the current page, and refreshes the
 * header sort indicators.
 */
function renderUrlsTable() {
    if (!urlsTableBody || !statisticsData.urls) return;

    // Prepare all URLs for pagination, with sorting
    allUrls = Object.entries(statisticsData.urls);
    sortUrls();

    totalItems = allUrls.length;

    // Clear the table
    urlsTableBody.innerHTML = '';
    
    if (totalItems === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td colspan="6" style="text-align: center; color: #718096; font-style: italic;">
                ${escapeHtml(t('stat_no_data'))}
            </td>
        `;
        urlsTableBody.appendChild(row);
        hidePagination();
        return;
    }
    
    // Show pagination when there are more than itemsPerPage entries
    if (totalItems > itemsPerPage) {
        showPagination();
        renderPagination();
    } else {
        hidePagination();
    }
    
    // Compute the range for the current page
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
    const pageUrls = allUrls.slice(startIndex, endIndex);

    // Render the URLs for the current page
    pageUrls.forEach(([url, data]) => {
        const row = document.createElement('tr');
        
        const successful = data.successfulRefreshes || 0;
        const total = data.totalRefreshes || 0;
        const successRate = total > 0 ? (successful / total * 100).toFixed(1) : '0.0';
        const loc = uiLocale();

        row.innerHTML = `
            <td title="${escapeHtml(url)}">${escapeHtml(truncateUrl(url, 50))}</td>
            <td>${data.totalRefreshes.toLocaleString(loc)}</td>
            <td>${formatActiveTime(data.totalActiveTime || 0)}</td>
            <td>${formatIntervalShort(data.averageInterval || 0)}</td>
            <td>${data.lastRefresh ? new Date(data.lastRefresh).toLocaleString(loc) : t('stat_never')}</td>
            <td>
                <span class="success-rate ${parseFloat(successRate) >= 95 ? 'high' : parseFloat(successRate) >= 80 ? 'medium' : 'low'}">
                    ${successRate}%
                </span>
            </td>
        `;
        urlsTableBody.appendChild(row);
    });
    
    // Update the sort indicators in the headers
    updateSortIndicators();
}

/**
 * Exports the cached statistics as a downloaded JSON file. Shows an error
 * toast (rather than emitting "statistics": null) if no statistics are loaded.
 */
async function exportStatistics() {
    // If a prior statistics load failed (all retries exhausted) statisticsData is still null —
    // instead of silently emitting a file with "statistics": null, we show an error.
    if (!statisticsData) {
        showNotification(t('stat_export_error'), 'error');
        return;
    }
    try {
        const exportData = {
            statistics: statisticsData,
            exportDate: new Date().toISOString(),
            period: t('all_time'),
            version: '1.0.0'
        };
        
        const dataStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `pages-auto-updater-statistics-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showNotification(t('stat_export_success'), 'success');
    } catch (error) {
        console.error('Error exporting statistics:', error);
        showNotification(t('stat_export_error'), 'error');
    }
}

/**
 * Confirms with the user, then asks the background to reset all statistics,
 * reloads the dashboard, and shows a success/error toast.
 */
async function resetStatistics() {
    const confirmed = await showConfirm(
        t('stat_reset_confirm'),
        t('stat_reset_confirm_title'),
        { type: 'danger', confirmText: t('reset'), cancelText: t('cancel') }
    );
    if (!confirmed) {
        return;
    }
    
    try {
        await sendStatsMessage({ action: 'resetStatistics' });

        // Reload the data
        await loadStatistics();
        
        showNotification(t('stat_reset_success'), 'success');
    } catch (error) {
        console.error('Error resetting statistics:', error);
        showNotification(t('stat_reset_error'), 'error');
    }
}

// Helper functions

/**
 * Builds the summary object consumed by renderGeneralStats/renderChanges from
 * the raw statistics data: overall totals plus today's accumulated counts and
 * the storage usage/quota reported by the background.
 * @param {object} data - The raw statistics object (general/daily/urls).
 * @returns {Promise<object>} Summary fields used by the render functions.
 */
async function calculateSummaryStatistics(data) {
    const today = new Date().toISOString().split('T')[0];
    const todayStats = data.daily[today] || { refreshes: 0, activeTime: 0, urls: {} };

    // Return only the fields that renderGeneralStats/renderChanges actually read.
    // (renderChanges shows today's accumulated values, not the difference from yesterday.)
    return {
        totalRefreshes: data.general.totalRefreshes || 0,
        averageInterval: data.general.averageInterval || 0,
        uniqueUrls: Object.keys(data.urls || {}).length,
        todayRefreshes: todayStats.refreshes || 0,
        todayUniqueUrls: Object.keys(todayStats.urls || {}).length,
        storageBytesUsed: data.general.storageBytesUsed, // from general, where the background put it
        storageQuotaBytes: data.general.storageQuotaBytes // from general
    };
}

/**
 * Formats a millisecond duration into a compact localized string, choosing the
 * granularity by magnitude: days+hours, hours+minutes, minutes, or seconds.
 * @param {number} ms - Duration in milliseconds.
 * @returns {string} Localized short-form active-time string.
 */
function formatActiveTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const totalDays = Math.floor(totalHours / 24);
    
    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;
    
    let display;
    
    const dayU = t('unit_day_short');
    const hourU = t('unit_hour_short');
    const minU = t('unit_min_short');
    const secU = t('unit_sec_short');

    if (totalDays > 0) {
        // More than a day: show days and hours
        display = hours > 0 ? `${totalDays}${dayU} ${hours}${hourU}` : `${totalDays}${dayU}`;
    } else if (totalHours > 0) {
        // More than an hour: show hours and minutes
        display = minutes > 0 ? `${totalHours}${hourU} ${minutes}${minU}` : `${totalHours}${hourU}`;
    } else if (totalMinutes > 0) {
        // More than a minute: show minutes
        display = `${totalMinutes}${minU}`;
    } else {
        // Less than a minute: show seconds
        display = `${totalSeconds}${secU}`;
    }

    return display;
}

/**
 * Truncates a URL to maxLength characters with an ellipsis, preferring to keep
 * the hostname intact and trimming the path; falls back to a plain substring
 * if the URL cannot be parsed.
 * @param {string} url - The URL to truncate.
 * @param {number} maxLength - Maximum length of the result.
 * @returns {string} The truncated URL.
 */
function truncateUrl(url, maxLength) {
    if (url.length <= maxLength) return url;
    
    try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname;
        const path = urlObj.pathname;
        
        if (domain.length + 3 >= maxLength) {
            return domain.substring(0, maxLength - 3) + '...';
        }
        
        const availableLength = maxLength - domain.length - 3;
        if (path.length > availableLength) {
            return domain + path.substring(0, availableLength) + '...';
        }
        
        return domain + path;
    } catch {
        return url.substring(0, maxLength - 3) + '...';
    }
}

/**
 * Returns an empty default statistics object used when the background has no
 * data to report.
 * @returns {object} Default statistics (general/daily/urls/intervals).
 */
function getDefaultStatistics() {
    return {
        general: {
            totalRefreshes: 0,
            extensionStartTime: Date.now(),
            totalActiveTime: 0,
            averageInterval: 0,
            lastResetDate: Date.now()
        },
        daily: {},
        urls: {},
        intervals: {}
    };
}

/**
 * Shows loading placeholders by setting every .stat-value element to '...'.
 */
function showLoadingState() {
    // Show loading indicators
    const loadingElements = document.querySelectorAll('.stat-value');
    loadingElements.forEach(el => {
        if (el) el.textContent = '...';
    });
}

/**
 * Hides the loading state. No-op: the rendered data has already replaced the
 * placeholders by the time this is called.
 */
function hideLoadingState() {
    // Hide loading indicators (data has already been rendered)
}

/**
 * Shows an error state by setting every .stat-value element to the localized
 * error string.
 */
function showErrorState() {
    const errorElements = document.querySelectorAll('.stat-value');
    errorElements.forEach(el => {
        if (el) el.textContent = t('stat_error');
    });
}

/**
 * Shows a toast notification.
 * @param {string} message - The message text.
 * @param {string} [type='info'] - Toast type (e.g. 'info', 'success', 'error').
 */
function showNotification(message, type = 'info') {
    showToast(message, type);
}

// Pagination functions
/**
 * Navigates to the given 1-based page and re-renders the URL table.
 * Out-of-range pages (page < 1 or page > totalPages) are ignored.
 * @param {number} page - Target page number (1-based).
 */
function goToPage(page) {
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    if (page < 1 || page > totalPages) return;
    
    currentPage = page;
    renderUrlsTable();
}

/**
 * Renders the pagination control: the "shown entries" info text, the
 * enabled/disabled state of the first/prev/next/last buttons, and a windowed
 * set of page-number buttons (up to maxVisiblePages) with leading/trailing
 * ellipses and the boundary pages.
 */
function renderPagination() {
    if (!paginationContainer || !paginationInfoText || !paginationPages) return;
    
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    const startItem = (currentPage - 1) * itemsPerPage + 1;
    const endItem = Math.min(currentPage * itemsPerPage, totalItems);
    
    // Update the pagination info text
    paginationInfoText.textContent = t('pagination_shown_entries')
        .replace('{start}', startItem)
        .replace('{end}', endItem)
        .replace('{total}', totalItems);
    
    // Update the navigation buttons' enabled/disabled state
    if (paginationFirstBtn) paginationFirstBtn.disabled = currentPage === 1;
    if (paginationPrevBtn) paginationPrevBtn.disabled = currentPage === 1;
    if (paginationNextBtn) paginationNextBtn.disabled = currentPage === totalPages;
    if (paginationLastBtn) paginationLastBtn.disabled = currentPage === totalPages;
    
    // Clear and rebuild the page-number buttons
    paginationPages.innerHTML = '';

    // Page-number display logic
    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    
    // Adjust if there are not enough pages at the end
    if (endPage - startPage + 1 < maxVisiblePages) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    // Add the first page and an ellipsis if needed
    if (startPage > 1) {
        addPageButton(1);
        if (startPage > 2) {
            addEllipsis();
        }
    }

    // Add the visible pages
    for (let i = startPage; i <= endPage; i++) {
        addPageButton(i);
    }

    // Add an ellipsis and the last page if needed
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            addEllipsis();
        }
        addPageButton(totalPages);
    }
}

/**
 * Appends a page-number button to the pagination control, marking it active
 * when it matches the current page and wiring its click to goToPage.
 * @param {number} pageNum - The page number the button targets.
 */
function addPageButton(pageNum) {
    const button = document.createElement('button');
    button.className = `pagination-page ${pageNum === currentPage ? 'active' : ''}`;
    button.textContent = pageNum;
    button.addEventListener('click', () => goToPage(pageNum));
    paginationPages.appendChild(button);
}

/**
 * Appends a non-interactive ellipsis ('...') element to the pagination control.
 */
function addEllipsis() {
    const ellipsis = document.createElement('span');
    ellipsis.className = 'pagination-ellipsis';
    ellipsis.textContent = '...';
    paginationPages.appendChild(ellipsis);
}

/**
 * Makes the pagination container visible (display: flex).
 */
function showPagination() {
    if (paginationContainer) {
        paginationContainer.style.display = 'flex';
    }
}

/**
 * Hides the pagination container (display: none).
 */
function hidePagination() {
    if (paginationContainer) {
        paginationContainer.style.display = 'none';
    }
}

// Sorting functions
/**
 * Marks the URL table's column headers as sortable and attaches click
 * handlers mapping each header to its sort key/type, then sets the initial
 * sort indicators.
 */
function setupTableSorting() {
    const table = document.getElementById('urls-table');
    if (!table) return;
    
    const headers = table.querySelectorAll('th');
    const sortableColumns = [
        { index: 0, key: 'url', type: 'string' },
        { index: 1, key: 'refreshes', type: 'number' },
        { index: 2, key: 'activeTime', type: 'number' },
        { index: 3, key: 'avgInterval', type: 'number' },
        { index: 4, key: 'lastRefresh', type: 'date' },
        { index: 5, key: 'successRate', type: 'number' }
    ];
    
    sortableColumns.forEach(column => {
        const header = headers[column.index];
        if (header) {
            header.classList.add('sortable');
            header.addEventListener('click', () => {
                handleSort(column.key, column.type);
            });
        }
    });
    
    // Set the initial sort state
    updateSortIndicators();
}

/**
 * Handles a sort-header click: toggles direction when the same column is
 * clicked again, otherwise switches column and picks a default direction
 * (ascending for strings, descending for everything else), resets to page 1,
 * then re-sorts and re-renders.
 * @param {string} columnKey - The sort key for the clicked column.
 * @param {string} columnType - The column data type ('string'|'number'|'date').
 */
function handleSort(columnKey, columnType) {
    // If the same column was clicked, flip the direction
    if (currentSortColumn === columnKey) {
        currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        // New column: descending for numeric, ascending for string
        currentSortColumn = columnKey;
        currentSortDirection = (columnType === 'string') ? 'asc' : 'desc';
    }

    // Reset to the first page when the sort changes
    currentPage = 1;

    // Re-sort and re-render
    sortUrls();
    renderUrlsTable();
}

/**
 * Sorts the module-level allUrls array in place by the current sort column and
 * direction. URL is compared case-insensitively; numeric/date columns compare
 * by their stored value (missing values treated as 0).
 */
function sortUrls() {
    if (!allUrls || allUrls.length === 0) return;
    
    allUrls.sort((a, b) => {
        const [urlA, dataA] = a;
        const [urlB, dataB] = b;
        
        let valueA, valueB;
        
        switch (currentSortColumn) {
            case 'url':
                valueA = urlA.toLowerCase();
                valueB = urlB.toLowerCase();
                break;
            case 'refreshes':
                valueA = dataA.totalRefreshes || 0;
                valueB = dataB.totalRefreshes || 0;
                break;
            case 'activeTime':
                valueA = dataA.totalActiveTime || 0;
                valueB = dataB.totalActiveTime || 0;
                break;
            case 'avgInterval':
                valueA = dataA.averageInterval || 0;
                valueB = dataB.averageInterval || 0;
                break;
            case 'lastRefresh':
                valueA = dataA.lastRefresh || 0;
                valueB = dataB.lastRefresh || 0;
                break;
            case 'successRate':
                const rateA = (dataA.totalRefreshes || 0) > 0
                    ? ((dataA.successfulRefreshes || 0) / dataA.totalRefreshes * 100)
                    : 0;
                const rateB = (dataB.totalRefreshes || 0) > 0
                    ? ((dataB.successfulRefreshes || 0) / dataB.totalRefreshes * 100)
                    : 0;
                valueA = rateA;
                valueB = rateB;
                break;
            default:
                return 0;
        }
        
        // Compare the values
        let comparison = 0;
        if (valueA < valueB) {
            comparison = -1;
        } else if (valueA > valueB) {
            comparison = 1;
        }

        // Apply the sort direction
        return currentSortDirection === 'asc' ? comparison : -comparison;
    });
}

/**
 * Updates the table headers' sort-indicator classes: clears sort-asc/sort-desc
 * from all sortable headers and applies the matching class to the currently
 * active sort column.
 */
function updateSortIndicators() {
    const table = document.getElementById('urls-table');
    if (!table) return;

    const headers = table.querySelectorAll('th.sortable');
    const columnMapping = {
        0: 'url',
        1: 'refreshes',
        2: 'activeTime',
        3: 'avgInterval',
        4: 'lastRefresh',
        5: 'successRate'
    };
    
    headers.forEach((header, index) => {
        // Remove all sort classes
        header.classList.remove('sort-asc', 'sort-desc');

        // Add the class for the currently active column
        if (columnMapping[index] === currentSortColumn) {
            header.classList.add(currentSortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

// Export functions for use in other modules
export { loadStatistics, renderStatistics };