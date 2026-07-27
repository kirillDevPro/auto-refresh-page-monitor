// statisticsCollector.js - Module for collecting extension usage statistics
import { STORAGE_QUOTA_BYTES } from './constants.js';

// Retention windows for auto-cleanup of old statistics data
const RETENTION_DAYS_DEFAULT = 90;     // normal cleanup run on every save
const RETENTION_DAYS_AGGRESSIVE = 30;  // when storage usage reaches 90% of quota

/**
 * Singleton collector that records page-refresh statistics into
 * chrome.storage.local. Tracks totals, per-day, per-URL, hourly, and
 * per-interval counters; serializes writes through an internal queue;
 * and runs retention-based plus quota-triggered graduated cleanup.
 */
export class StatisticsCollector {
    /**
     * Initialize the in-memory state and kick off async initialization.
     * Sets up the write queue and stores the initialization promise so
     * callers can await readiness via ensureInitialized().
     */
    constructor() {
        this._isInitialized = false;
        this._writeQueue = Promise.resolve();
        this._initializationPromise = this._initialize();
    }

    /**
     * One-time async initialization: read current statistics and, on first
     * run, seed general.extensionStartTime. The seed save is best-effort —
     * its failure does not block initialization since the read succeeded.
     * On a read error, null out the initialization promise so a later
     * ensureInitialized() can retry.
     * @returns {Promise<void>}
     */
    async _initialize() {
        if (this._isInitialized) return;
        try {
            const stats = await this.getStatisticsInternal();
            if (!stats.general.extensionStartTime) {
                stats.general.extensionStartTime = Date.now();
                // Best-effort seed write: its failure (e.g. storage unavailable across an SW transition) must
                // not block _isInitialized — the read already succeeded, which is enough.
                try { await this.saveStatistics(stats); } catch (e) { /* seed best-effort */ }
            }
            this._isInitialized = true;
        } catch (error) {
            console.error("Error during StatisticsCollector initialization:", error);
            // Null out the promise so the next ensureInitialized() recreates it and retries,
            // rather than getting stuck on an already-resolved incomplete promise until a cold start.
            this._initializationPromise = null;
        }
    }

    /**
     * Await one-time initialization, recreating the initialization promise
     * if a prior attempt nulled it out (singleton is re-initializable).
     * @returns {Promise<void>}
     */
    async ensureInitialized() {
        if (this._isInitialized) return;
        // Recreate the promise if the previous attempt reset it to null (singleton re-initializable).
        if (!this._initializationPromise) {
            this._initializationPromise = this._initialize();
        }
        await this._initializationPromise;
    }

    /**
     * Public accessor: ensure one-time initialization has completed, then
     * return the raw statistics object from storage.
     * @returns {Promise<object>} The stored statistics, or defaults.
     */
    async getStatistics() {
        await this.ensureInitialized();
        return this.getStatisticsInternal();
    }
    
    /**
     * Queue a refresh-recording write so concurrent refreshes don't race.
     * Errors are caught and logged; the queue chain is preserved.
     * @param {number} tabId - ID of the refreshed tab.
     * @param {string} url - URL that was refreshed.
     * @param {number} interval - Refresh interval in seconds.
     * @param {boolean} [success=true] - Whether the refresh succeeded.
     * @returns {Promise<void>} Resolves when this write completes.
     */
    recordRefresh(tabId, url, interval, success = true) {
        const thisWrite = this._writeQueue.then(
            () => this._recordRefreshInternal(tabId, url, interval, success)
        ).catch((error) => {
            console.error('Error recording refresh statistics:', error);
        });
        this._writeQueue = thisWrite;
        return thisWrite;
    }

    /**
     * Apply a single refresh to all statistics buckets (general, daily,
     * per-day-per-URL, hourly pattern, per-URL, and per-interval), then
     * persist. Maintains incremental averages instead of unbounded arrays.
     * @param {number} tabId - ID of the refreshed tab (unused; kept for API symmetry).
     * @param {string} url - URL that was refreshed.
     * @param {number} interval - Refresh interval in seconds.
     * @param {boolean} success - Whether the refresh succeeded.
     * @returns {Promise<void>}
     */
    async _recordRefreshInternal(tabId, url, interval, success) {
        const stats = await this.getStatistics();
        const today = this.getTodayKey();
        const hour = new Date().getHours();

        // General statistics
        stats.general.totalRefreshes++;
        this.updateAverageInterval(stats, interval);

        // Add the interval duration to the total active time
        const intervalMs = interval * 1000; // convert seconds to milliseconds
        stats.general.totalActiveTime += intervalMs;

        // Daily statistics
        if (!stats.daily[today]) {
            stats.daily[today] = {
                refreshes: 0,
                activeTime: 0,
                urls: {}, // Structure for storing per-URL statistics for the day
                intervalSum: 0,
                intervalCount: 0,
                hourlyPattern: new Array(24).fill(0),
                successfulRefreshes: 0,
                failedRefreshes: 0
            };
        }

        stats.daily[today].refreshes++;
        stats.daily[today].activeTime += intervalMs; // add the interval duration

        // Update statistics for the specific URL for the current day
        if (!stats.daily[today].urls) {
            stats.daily[today].urls = {};
        }
        if (!stats.daily[today].urls[url]) {
            stats.daily[today].urls[url] = {
                refreshes: 0,
                activeTime: 0,
                successfulRefreshes: 0,
                failedRefreshes: 0
            };
        }
        stats.daily[today].urls[url].refreshes++;
        stats.daily[today].urls[url].activeTime += intervalMs;
        if (success) {
            stats.daily[today].urls[url].successfulRefreshes++;
        } else {
            stats.daily[today].urls[url].failedRefreshes++;
        }

        // Incremental average instead of unbounded array (prevents storage bloat)
        stats.daily[today].intervalSum = (stats.daily[today].intervalSum || 0) + interval;
        stats.daily[today].intervalCount = (stats.daily[today].intervalCount || 0) + 1;
        stats.daily[today].hourlyPattern[hour]++;

        if (success) {
            stats.daily[today].successfulRefreshes++;
        } else {
            stats.daily[today].failedRefreshes++;
        }

        // Per-URL statistics
        if (!stats.urls[url]) {
            stats.urls[url] = {
                totalRefreshes: 0,
                lastRefresh: null,
                totalActiveTime: 0,
                averageInterval: 0,
                successfulRefreshes: 0,
                failedRefreshes: 0,
                firstSeen: Date.now()
            };
        }

        stats.urls[url].totalRefreshes++;
        stats.urls[url].lastRefresh = Date.now();
        stats.urls[url].totalActiveTime += intervalMs; // add the interval duration for this URL

        if (success) {
            stats.urls[url].successfulRefreshes++;
        } else {
            stats.urls[url].failedRefreshes++;
        }

        // Update the average interval for this URL
        this.updateUrlAverageInterval(stats.urls[url], interval);

        // Per-interval statistics
        const intervalKey = interval.toString();
        stats.intervals[intervalKey] = (stats.intervals[intervalKey] || 0) + 1;

        await this.saveStatistics(stats);
    }

    /**
     * Read the raw statistics object from chrome.storage.local, returning
     * defaults if absent or on error. Does not trigger initialization.
     * @returns {Promise<object>} The stored statistics, or defaults.
     */
    async getStatisticsInternal() {
        try {
            const { statistics } = await chrome.storage.local.get('statistics');
            return statistics || this.getDefaultStatistics();
        } catch (error) {
            console.error('Error getting statistics internal:', error);
            return this.getDefaultStatistics();
        }
    }

    /**
     * Aggregate statistics over the last `days` days. Filters daily records
     * by date, re-derives general totals and average interval from them,
     * and rebuilds per-URL period totals on top of all-time URL base data.
     * The `intervals` map is passed through unfiltered (not stored per day).
     * @param {number|string|null} [days=30] - Days to include; 'all' or null returns everything.
     * @returns {Promise<object>} Aggregated {general, daily, urls, intervals}.
     */
    async getStatisticsByPeriod(days = 30) {
        const allStats = await this.getStatistics();

        if (days === 'all' || days === null) {
            return allStats;
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffTimestamp = cutoffDate.getTime();

        // 1. Filter the daily records
        const filteredDaily = {};
        Object.keys(allStats.daily).forEach(dateKey => {
            if (new Date(dateKey).getTime() >= cutoffTimestamp) {
                filteredDaily[dateKey] = allStats.daily[dateKey];
            }
        });

        // 2. Aggregate the data. Spreading allStats.general preserves extensionStartTime/
        // lastResetDate (the consumer needs them for extensionAge); the counters below are zeroed.
        const newGeneralStats = { ...allStats.general, totalRefreshes: 0, totalActiveTime: 0, averageInterval: 0 };
        const urlsInPeriodData = {};
        let intervalSum = 0;
        let intervalCount = 0;

        Object.values(filteredDaily).forEach(dayStats => {
            // Aggregate the general metrics
            newGeneralStats.totalRefreshes += dayStats.refreshes || 0;
            newGeneralStats.totalActiveTime += dayStats.activeTime || 0;
            if (dayStats.intervalSum !== undefined && dayStats.intervalCount !== undefined) {
                intervalSum += dayStats.intervalSum;
                intervalCount += dayStats.intervalCount;
            }

            // Aggregate the per-URL data
            if (dayStats.urls) {
                Object.entries(dayStats.urls).forEach(([url, urlDayStats]) => {
                    if (!urlsInPeriodData[url]) {
                        urlsInPeriodData[url] = { totalRefreshes: 0, totalActiveTime: 0, successfulRefreshes: 0, failedRefreshes: 0 };
                    }
                    urlsInPeriodData[url].totalRefreshes += urlDayStats.refreshes || 0;
                    urlsInPeriodData[url].totalActiveTime += urlDayStats.activeTime || 0;
                    urlsInPeriodData[url].successfulRefreshes += urlDayStats.successfulRefreshes || 0;
                    urlsInPeriodData[url].failedRefreshes += urlDayStats.failedRefreshes || 0;
                });
            }
        });
        
        newGeneralStats.averageInterval = intervalCount > 0 ? Math.round(intervalSum / intervalCount) : 0;

        // 3. Build the final `filteredUrls` object
        const filteredUrls = {};
        Object.entries(urlsInPeriodData).forEach(([url, periodData]) => {
            const baseAllTimeData = allStats.urls[url] || {};
            filteredUrls[url] = {
                ...baseAllTimeData,
                totalRefreshes: periodData.totalRefreshes,
                totalActiveTime: periodData.totalActiveTime,
                successfulRefreshes: periodData.successfulRefreshes,
                failedRefreshes: periodData.failedRefreshes,
            };
        });

        return {
            general: newGeneralStats,
            daily: filteredDaily,
            urls: filteredUrls,
            intervals: allStats.intervals,
        };
    }

    /**
     * Run standard retention cleanup, persist the stats, then check storage
     * usage. Above 90% of quota: graduated cleanup — stage 1 shrinks
     * retention to 30 days, stage 2 prunes URLs to the top 100 by
     * lastRefresh. There is no stage that wipes everything silently; if
     * usage is still high it is only logged.
     * @param {object} stats - The statistics object to persist (mutated by cleanup).
     * @returns {Promise<void>}
     */
    async saveStatistics(stats) {
        try {
            // Clean up old data (older than 90 days)
            this.cleanupOldData(stats);
            await chrome.storage.local.set({ statistics: stats });

            // Check storage usage — graduated cleanup instead of a destructive wipe
            const bytesInUse = await chrome.storage.local.getBytesInUse('statistics');
            const usagePercentage = (bytesInUse / STORAGE_QUOTA_BYTES) * 100;

            if (usagePercentage > 90) {
                console.warn(`Storage usage at ${usagePercentage.toFixed(1)}% — running aggressive cleanup`);

                // Stage 1: Aggressive cleanup (shrink retention to 30 days)
                this._aggressiveCleanup(stats);
                await chrome.storage.local.set({ statistics: stats });

                // Re-check
                const bytesAfterStage1 = await chrome.storage.local.getBytesInUse('statistics');
                const usageAfterStage1 = (bytesAfterStage1 / STORAGE_QUOTA_BYTES) * 100;

                if (usageAfterStage1 > 90) {
                    // Stage 2: Keep only the top 100 URLs by lastRefresh
                    this._pruneUrlsToLimit(stats, 100);
                    await chrome.storage.local.set({ statistics: stats });
                    console.warn(`Storage at ${usageAfterStage1.toFixed(1)}% after stage 1 — pruning URLs to top 100`);
                }

                // No stage 3 — never wipe all statistics silently
                const bytesAfterStage2 = await chrome.storage.local.getBytesInUse('statistics');
                const usageAfterStage2 = (bytesAfterStage2 / STORAGE_QUOTA_BYTES) * 100;
                if (usageAfterStage2 > 90) {
                    console.error(`Storage still at ${usageAfterStage2.toFixed(1)}% after all cleanup stages. Manual reset may be needed.`);
                }
            }
        } catch (error) {
            console.error('Error saving statistics:', error);
        }
    }

    /**
     * Overwrite stored statistics with a fresh default object.
     * @returns {Promise<void>}
     */
    async resetStatistics() {
        try {
            await chrome.storage.local.set({
                statistics: this.getDefaultStatistics()
            });
        } catch (error) {
            console.error('Error resetting statistics:', error);
        }
    }

    /**
     * Return the current statistics augmented with an exportDate (ISO
     * timestamp) and a version string, suitable for download/backup.
     * @returns {Promise<object>} Statistics plus {exportDate, version}.
     */
    async exportStatistics() {
        const stats = await this.getStatistics();
        return {
            ...stats,
            exportDate: new Date().toISOString(),
            version: '1.0.0'
        };
    }

    /**
     * Build a fresh, empty statistics object with general counters seeded
     * (extensionStartTime and lastResetDate set to now) and empty daily,
     * urls, and intervals maps.
     * @returns {object} A default statistics object.
     */
    getDefaultStatistics() {
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

    // Helper methods
    /**
     * Return today's date key in YYYY-MM-DD form (UTC, from ISO string).
     * @returns {string} The date key used in the daily statistics map.
     */
    getTodayKey() {
        return new Date().toISOString().split('T')[0];
    }

    /**
     * Fold a new interval into the running average in stats.general using
     * an incremental mean over general.totalRefreshes (rounded).
     * @param {object} stats - The statistics object (general.averageInterval is mutated).
     * @param {number} newInterval - The new interval in seconds.
     */
    updateAverageInterval(stats, newInterval) {
        const total = stats.general.totalRefreshes;
        if (total === 1) {
            stats.general.averageInterval = newInterval;
        } else {
            const currentAvg = stats.general.averageInterval || 0;
            stats.general.averageInterval = Math.round(
                (currentAvg * (total - 1) + newInterval) / total
            );
        }
    }

    /**
     * Fold a new interval into a per-URL running average using an
     * incremental mean over urlStats.totalRefreshes (rounded).
     * @param {object} urlStats - A per-URL stats object (averageInterval is mutated).
     * @param {number} newInterval - The new interval in seconds.
     */
    updateUrlAverageInterval(urlStats, newInterval) {
        const total = urlStats.totalRefreshes;
        if (total === 1) {
            urlStats.averageInterval = newInterval;
        } else {
            const currentAvg = urlStats.averageInterval || 0;
            urlStats.averageInterval = Math.round(
                (currentAvg * (total - 1) + newInterval) / total
            );
        }
    }

    /**
     * Shared cleanup: delete daily records before the cutoff date, URLs not
     * refreshed since the cutoff (or with a null lastRefresh), and zero/
     * negative interval-count entries. Mutates `stats` in place.
     * @param {object} stats - The statistics object to prune.
     * @param {number} retentionDays - Days to retain; older data is removed.
     */
    _cleanupOlderThan(stats, retentionDays) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffKey = cutoffDate.toISOString().split('T')[0];
        const cutoffTimestamp = cutoffDate.getTime();

        // Delete old daily data
        Object.keys(stats.daily).forEach(dateKey => {
            if (dateKey < cutoffKey) {
                delete stats.daily[dateKey];
            }
        });

        // Delete URLs not refreshed within the retention window (or with a null lastRefresh)
        if (stats.urls) {
            Object.keys(stats.urls).forEach(url => {
                const urlData = stats.urls[url];
                if (!urlData.lastRefresh || urlData.lastRefresh < cutoffTimestamp) {
                    delete stats.urls[url];
                }
            });
        }

        // Delete zero-count interval entries
        if (stats.intervals) {
            Object.keys(stats.intervals).forEach(key => {
                if (!stats.intervals[key] || stats.intervals[key] <= 0) {
                    delete stats.intervals[key];
                }
            });
        }
    }

    /**
     * Standard retention cleanup (90 days). Mutates `stats` in place.
     * @param {object} stats - The statistics object to prune.
     */
    cleanupOldData(stats) {
        this._cleanupOlderThan(stats, RETENTION_DAYS_DEFAULT);
    }

    /**
     * Aggressive retention cleanup (30 days), used when storage exceeds 90%
     * of quota. Mutates `stats` in place.
     * @param {object} stats - The statistics object to prune.
     */
    _aggressiveCleanup(stats) {
        this._cleanupOlderThan(stats, RETENTION_DAYS_AGGRESSIVE);
    }

    /**
     * Keep only the `limit` most recently refreshed URLs (by lastRefresh),
     * deleting the rest from stats.urls. No-op when at or below the limit.
     * Mutates `stats` in place.
     * @param {object} stats - The statistics object to prune.
     * @param {number} limit - Maximum number of URLs to retain.
     */
    _pruneUrlsToLimit(stats, limit) {
        if (!stats.urls) return;
        const urls = Object.entries(stats.urls);
        if (urls.length <= limit) return;

        urls.sort((a, b) => (b[1].lastRefresh || 0) - (a[1].lastRefresh || 0));

        const toKeep = new Set(urls.slice(0, limit).map(([url]) => url));
        Object.keys(stats.urls).forEach(url => {
            if (!toKeep.has(url)) {
                delete stats.urls[url];
            }
        });
    }

}

// Export the single shared instance
export const statisticsCollector = new StatisticsCollector();