// ============================================================
// TempPad — Cleanup job
// ============================================================
// Deletes all expired files from the database.
//
// This is Layer 2 of the expiration system:
//   Layer 1 (Lazy enforcement): every query includes expires_at > now()
//            so expired files are never readable/writable.
//   Layer 2 (This job): periodically DELETEs expired rows to free
//            disk space and keep the table small.
//   Layer 3 (Standalone script): scripts/cleanup.js does the same
//            thing and can be run by an external cron job.
//
// The DELETE is idempotent — running it from multiple server
// instances at the same time is safe. Each instance deletes
// whatever expired rows it finds; if another instance already
// deleted them, the DELETE simply affects 0 rows. No advisory
// lock is needed because there's no harm in concurrent DELETEs
// on the same rows (the second DELETE just finds nothing to do).
// ============================================================

'use strict';

const fileService = require('../services/fileService');

/**
 * Run the cleanup once.
 * @returns {Promise<number>} Number of deleted rows.
 */
async function runCleanup() {
    try {
        const count = await fileService.deleteExpired();
        if (count > 0) {
            console.log(`[Cleanup] Deleted ${count} expired file(s).`);
        }
        return count;
    } catch (err) {
        console.error('[Cleanup] Error during cleanup:', err.message);
        return 0;
    }
}

/**
 * Start the periodic cleanup scheduler.
 * Runs cleanup immediately on startup, then every CLEANUP_INTERVAL_MS.
 *
 * @param {number} intervalMs - How often to run (default from config).
 * @returns {NodeJS.Timeout} The interval handle (for clearing on shutdown).
 */
function startScheduler(intervalMs) {
    console.log(`[Cleanup] Starting scheduler (every ${intervalMs / 1000}s).`);

    // Run immediately on startup to catch anything that expired
    // while the server was down (e.g., free-tier sleep).
    runCleanup();

    // Then run periodically.
    return setInterval(runCleanup, intervalMs);
}

module.exports = { runCleanup, startScheduler };
