/**
 * Orchestrates the Manifest V3 service worker.
 *
 * Imports background modules, injects cross-dependencies to avoid circular imports, registers
 * lifecycle listeners, debounces scheduled-refresh reapplication, wires auto-recovery callbacks,
 * and starts the initial bootstrap with a delayed retry on failure.
 */

import {
    loadGlobalSettings,
    setupGlobalSettingsListener
} from './settings.js';

import {
    initializeLifecycle,
    setupGlobalErrorHandlers,
    ensureInitialized,
    resetInitialization
} from './lifecycle.js';

import { initializeStateManagement } from './state.js';

import { updateIconBadge, initializeIconController } from './iconController.js';
import { setupMessageHandler } from './messageHandler.js';
import { initializeAlarmHandler, forceCheckAlarmForTab } from './alarmHandler.js';
import { initializeTabLifecycleHandlers, cleanupRefresher as cleanupRefresherFromLifecycle } from './tabLifecycle.js';
import {
    initializeScheduler,
    applyScheduledRefreshIfNeeded,
    urlMatchesAnyEnabledSchedule,
    deactivateScheduledTab,
    reapplyTimersOnStartup,
    reapplyScheduledRefreshesToAllTabs
} from './scheduler.js';
import { playNotificationSound, logActivity } from './notifications.js';
import { statisticsCollector } from './statisticsCollector.js';
import {
    initializeNavigationRecovery,
    handleRecoveryAlarm,
    checkStuckLoads,
    checkReconnect
} from './navigationRecovery.js';
import { initializeContextMenu } from './contextMenu.js';
import { initializeCommands } from './commands.js';
import { BULK_ACTIONS, handleBulkMessage } from './bulkActions.js';

/**
 * Core bootstrap body invoked by lifecycle.js during initialization.
 * Loads global settings first (so subsequent logic judges by real settings, not
 * seed defaults), then re-applies persisted timers on startup.
 * @returns {Promise<void>}
 */
async function mainInitialize() {
    console.log('Running main initialization');

    // Load settings before reapplying timers so all decisions use stored settings, not defaults.
    await loadGlobalSettings();

    // Reapply timers on startup, including scheduled rules and restorable manual timers.
    await reapplyTimersOnStartup();

    console.log('Main initialization completed');
}

chrome.runtime.onStartup.addListener(async () => {
    console.log("Extension startup event.");
    await ensureInitialized();
});

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log("Extension installed or updated:", details.reason);
    // On install/update the service worker starts with a clean module scope, but the top-level
    // ensureInitialized() below may have already set bootstrapPromise, making this call a no-op
    // and reapplyTimersOnStartup might not run after the update (Chrome preserves periodic
    // alarms, but consumed one-shots vanish). We await the current initialization, then
    // force a clean re-bootstrap, equivalent to a manual off/on, guaranteeing re-arm of all timers.
    // We do the reset+retry only on success of the first bootstrap. If it failed (storage unavailable),
    // ensureInitialized has already cleared the state for a retry, and the top-level 3s retry (below) will
    // pick it up; forcing a reset here would make the two bootstrap paths collide.
    try {
        await ensureInitialized();
        resetInitialization();
        await ensureInitialized();
    } catch (error) {
        console.warn('onInstalled bootstrap failed; leaving recovery to the retry path:', error?.message);
    }
});

// Coalesce frequent rescheduling: a single settings save emits several signals
// (onChanged sync + onChanged local + the globalSettingsUpdated message). Without debouncing,
// reapplyScheduledRefreshesToAllTabs would run 2-3 times in a row per save.
let _reapplyTimer = null;
/**
 * Debounced wrapper around reapplyScheduledRefreshesToAllTabs: coalesces the
 * burst of save signals (sync/local onChanged + the globalSettingsUpdated message)
 * into a single reapply 250ms after the last call. Returns immediately.
 * @returns {Promise<void>} resolves right away; the reapply runs later on the timer
 */
function reapplyScheduledRefreshesDebounced() {
    if (_reapplyTimer) clearTimeout(_reapplyTimer);
    _reapplyTimer = setTimeout(() => {
        _reapplyTimer = null;
        reapplyScheduledRefreshesToAllTabs().catch(err =>
            console.error('Failed to reapply scheduled refreshes:', err)
        );
    }, 250);
    return Promise.resolve();
}

setupGlobalSettingsListener(reapplyScheduledRefreshesDebounced);
// Initialize state management with the badge updater dependency.
initializeStateManagement({
    updateIconBadge: updateIconBadge // Icon-controller badge updater.
});

// Register message handling for popup/settings actions.
setupMessageHandler({
    reapplyScheduledRefreshesToAllTabs: reapplyScheduledRefreshesDebounced,
    statisticsCollector, // Statistics collector singleton.
    logActivity, // Activity-log writer.
    // Injected so messageHandler routes bulk actions without importing bulkActions.js (which imports
    // the start/stop helpers back from messageHandler — a direct import here would be a cycle).
    bulkActions: { actions: BULK_ACTIONS, handle: handleBulkMessage }
});

// Registers webNavigation listeners synchronously here (first service-worker event-loop turn) if the optional
// permission is already granted, and reacts to a runtime grant/revoke. Must run before
// initializeAlarmHandler so the recovery-alarm/stuck-sweep callbacks below are wired into it.
initializeNavigationRecovery({ logActivity });

// Register alarm handling for refresh, recovery, and keepalive alarms.
initializeAlarmHandler({
    playNotificationSound,
    logActivity,
    cleanupRefresher: cleanupRefresherFromLifecycle,
    statisticsCollector,   // pass the statistics collector
    urlMatchesAnyEnabledSchedule, // Gate scheduled reloads by live URL match.
    deactivateScheduledTab,       // Shared scheduled-tab teardown.
    handleRecoveryAlarm,          // Fires a backed-off recovery reload.
    checkStuckLoads,              // Runs orphan-recovery and stuck-load sweeps.
    checkReconnect                // Fast-forwards pending recoveries on a network reconnect.
});

// Wire icon controller with the force-check callback so the badge timer can
// trigger overdue alarms immediately (avoids 15-30s keepalive delay).
initializeIconController({ forceCheckAlarm: forceCheckAlarmForTab });

// Register tab lifecycle handlers for close cleanup and URL-rule application.
initializeTabLifecycleHandlers({ 
    applyScheduledRefreshIfNeeded
});

// Initialize scheduler with its dependencies
initializeScheduler({
    logActivity,
    statisticsCollector
});

// Register the right-click context menu (start/control auto-refresh on the current tab). Registers its
// listeners synchronously and reuses the shared start/pause/resume/stop helpers from messageHandler.
initializeContextMenu();

// Register keyboard shortcuts (chrome.commands). Same class of registration as the context menu:
// the listener must be attached synchronously in this first event-loop turn, or a shortcut pressed
// while the service worker is asleep would restart it and then find no listener for its own event.
initializeCommands();

// Initialize lifecycle management with dependencies.
initializeLifecycle({
    mainInitialize: mainInitialize,
    logActivity: logActivity
});

// Register global error handlers for service-worker recovery.
setupGlobalErrorHandlers();

// Initialize immediately when the service worker loads, which is critical for wake-up scenarios.
console.log('Service worker loading, initializing extension...');
ensureInitialized().then(() => {
    console.log('Initial bootstrap successful');
    logActivity(null, 'Extension initialized successfully');
}).catch((error) => {
    console.error('Bootstrap failed on service worker load:', error);
    logActivity(null, `Bootstrap failed: ${error.message}`);

    // Retry after a delay
    setTimeout(() => {
        console.log('Retrying initialization after initial failure...');
        resetInitialization();
        ensureInitialized().catch(console.error);
    }, 3000);
});
