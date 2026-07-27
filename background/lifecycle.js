// lifecycle.js
// Service Worker lifecycle management: one-shot bootstrap orchestration plus a 30s keepalive
// alarm whose tick detects prior SW suspension, runs a cheap storage-liveness check, and
// re-bootstraps on suspension/crash. Also installs global error/unhandledrejection recovery
// handlers (30s cooldown). The keepalive alarm is the sole health mechanism.

import {
    ALARM_NAMES,
    KEEPALIVE_INTERVAL_MINUTES,
    SUSPENSION_THRESHOLD_MS,
    MAX_KEEPALIVE_FAILURES
} from './constants.js';

// Initialization state tracking
let initialized = false;
let bootstrapPromise = null;

// Keepalive tracking for suspension detection
let lastKeepaliveTime = Date.now();
let keepaliveFailCount = 0;

// Dependencies that will be injected
let dependencies = {};

/**
 * Initialize the lifecycle management system with required dependencies
 */
export function initializeLifecycle(deps) {
    dependencies = deps;
    console.log('Lifecycle management initialized');
}

/**
 * Setup the keepalive alarm. NB: a periodic alarm does NOT keep the SW alive between
 * fires — it wakes the SW (~every 30s; Chrome clamps periods < 0.5 min) and runs the
 * handler, which performs the sweep of missed alarms and the suspension check.
 */
export async function setupKeepaliveAlarm() {
    try {
        await chrome.alarms.clear(ALARM_NAMES.KEEPALIVE);
        await chrome.alarms.create(ALARM_NAMES.KEEPALIVE, {
            delayInMinutes: KEEPALIVE_INTERVAL_MINUTES,
            periodInMinutes: KEEPALIVE_INTERVAL_MINUTES
        });
        console.log(`Keepalive alarm created (${KEEPALIVE_INTERVAL_MINUTES} min intervals)`);
    } catch (error) {
        console.error('Failed to setup keepalive alarm:', error);
    }
}

/**
 * Handle the keepalive alarm tick: detect a prior suspension and run health/storage checks.
 * The alarm wakes the SW to run this handler; it does not hold the SW alive between ticks.
 */
export async function handleKeepaliveAlarm() {
    const now = Date.now();
    const timeSinceLastKeepalive = now - lastKeepaliveTime;

    // If more than threshold has passed, service worker was likely suspended
    if (timeSinceLastKeepalive > SUSPENSION_THRESHOLD_MS) {
        console.warn(
            `Service worker was suspended for ${Math.round(timeSinceLastKeepalive / 1000)}s, reinitializing...`
        );

        // Try to log using the dependency if available
        if (dependencies.logActivity) {
            try {
                dependencies.logActivity(
                    null,
                    `Service worker resumed after ${Math.round(timeSinceLastKeepalive / 1000)}s suspension`
                );
            } catch (e) {
                console.error('Logger unavailable during recovery', e);
            }
        }

        resetInitialization();
        await ensureInitialized();
        keepaliveFailCount = 0;
    }

    lastKeepaliveTime = now;

    // Cheap storage-liveness check on every wake (also keeps this tick busy).
    // getBytesInUse(null), NOT get(null): returns only the size without deserializing the whole
    // store (statistics can grow to megabytes), yet still throws if storage is unavailable.
    try {
        await chrome.storage.local.getBytesInUse(null);
        keepaliveFailCount = 0;
    } catch (error) {
        keepaliveFailCount++;
        console.error(`Keepalive storage check failed (count: ${keepaliveFailCount}):`, error);

        if (keepaliveFailCount > MAX_KEEPALIVE_FAILURES) {
            console.error('Multiple keepalive failures, attempting full reset...');
            resetInitialization();
            await ensureInitialized();
            keepaliveFailCount = 0;
        }
    }
}

/**
 * Reset all initialization state (used after service worker wake from sleep)
 */
export function resetInitialization() {
    console.warn('Resetting initialization state');

    if (dependencies.logActivity) {
        try {
            dependencies.logActivity(null, 'Resetting initialization state');
        } catch (e) {
            console.error('Logger unavailable during reset:', e);
        }
    }

    initialized = false;
    bootstrapPromise = null;
    lastKeepaliveTime = Date.now();
    keepaliveFailCount = 0;
}

/**
 * Run all initialization exactly once: invoke the injected mainInitialize(), then arm the
 * keepalive alarm, and set `initialized = true` only AFTER all async work succeeds. On error,
 * reset `initialized`/`bootstrapPromise` and rethrow without retrying (background.js owns retry).
 */
async function bootstrap() {
    if (initialized) {
        console.warn('Already initialized, skipping bootstrap');
        return;
    }

    try {
        console.log('Starting bootstrap');

        // Call the main initialization function from dependencies
        if (dependencies.mainInitialize) {
            await dependencies.mainInitialize();
        }

        // Setup keepalive after successful initialization
        await setupKeepaliveAlarm();

        // Mark as initialized only AFTER all async work completes successfully
        initialized = true;
        console.log('Bootstrap completed successfully');
    } catch (error) {
        console.error('Critical bootstrap error:', error);

        if (dependencies.logActivity) {
            try {
                dependencies.logActivity(null, `Bootstrap error: ${error.message}`);
            } catch (e) {
                console.error('Failed to log error:', e);
            }
        }

        initialized = false;
        bootstrapPromise = null;

        // Do NOT retry here — background.js already handles retry with setTimeout(3000)
        // Having two independent retry paths causes race conditions (double bootstrap)
        throw error;
    }
}

/**
 * Ensures bootstrap runs exactly once and returns a promise
 */
export function ensureInitialized() {
    if (!bootstrapPromise) {
        bootstrapPromise = bootstrap().catch((error) => {
            // If bootstrap fails, reset so it can be retried
            console.error('Bootstrap promise failed, resetting for retry', error);
            bootstrapPromise = null;
            initialized = false;
            throw error;
        });
    }
    return bootstrapPromise;
}

// The sole health mechanism is the keepalive alarm (handleKeepaliveAlarm): storage-liveness + re-init
// every 30s. There is deliberately no separate setTimeout loop here — a timer does not survive SW
// suspension (it would die after the first sleep), whereas an alarm does.

/**
 * Setup global error handlers for recovery
 */
export function setupGlobalErrorHandlers() {
    // Cooldown: prevent re-bootstrap more than once per 30 seconds
    let lastRecoveryTime = 0;
    const RECOVERY_COOLDOWN_MS = 30000;

    /**
     * Gate a recovery re-bootstrap: returns false (and skips) when within the 30s cooldown or
     * when the SW is already fully initialized; otherwise stamps lastRecoveryTime and returns true.
     */
    function shouldAttemptRecovery() {
        const now = Date.now();
        if (now - lastRecoveryTime < RECOVERY_COOLDOWN_MS) {
            console.warn('Skipping recovery — cooldown active (last recovery',
                Math.round((now - lastRecoveryTime) / 1000), 's ago)');
            return false;
        }
        // Skip recovery if already fully initialized
        if (bootstrapPromise && initialized) {
            console.warn('Skipping recovery — already initialized');
            return false;
        }
        lastRecoveryTime = now;
        return true;
    }

    // Global error handler to prevent Service Worker crashes
    self.addEventListener('error', (event) => {
        console.error('Service Worker Error:', event.error);

        if (dependencies.logActivity) {
            try {
                dependencies.logActivity(null, `Uncaught error: ${event.error?.message || String(event.error)}`);
            } catch (logError) {
                console.error('Failed to log error:', logError);
            }
        }

        event.preventDefault();

        if (shouldAttemptRecovery()) {
            setTimeout(() => {
                console.log('Attempting to recover from error...');
                resetInitialization();
                ensureInitialized().catch(console.error);
            }, 1000);
        }
    });

    // Handle unhandled promise rejections
    self.addEventListener('unhandledrejection', (event) => {
        console.error('Unhandled Promise Rejection:', event.reason);

        if (dependencies.logActivity) {
            try {
                dependencies.logActivity(null, `Unhandled rejection: ${event.reason?.message || String(event.reason)}`);
            } catch (logError) {
                console.error('Failed to log rejection:', logError);
            }
        }

        event.preventDefault();

        if (shouldAttemptRecovery()) {
            setTimeout(() => {
                console.log('Attempting to recover from rejection...');
                resetInitialization();
                ensureInitialized().catch(console.error);
            }, 1000);
        }
    });

    console.log('Global error handlers registered');
}
