// ============================================================
// TempPad — HTTP server entry point
// ============================================================
// Starts the Express server, the cleanup scheduler, and handles
// graceful shutdown on SIGTERM/SIGINT.
//
// This file is the ONLY entry point for running the app.
// app.js is imported but not started, so tests can use it
// directly with Supertest without binding to a port.
// ============================================================

'use strict';

const app = require('./app');
const config = require('./config/env');
const db = require('./db/pool');
const cleanup = require('./jobs/cleanup');

// --- Start the HTTP server ---
const server = app.listen(config.port, () => {
    console.log(`\n🚀 TempPad is running at http://localhost:${config.port}`);
    console.log(`   Environment: ${config.nodeEnv}`);
    console.log(`   File TTL: ${config.fileTtlSeconds} seconds`);
    console.log(`   Cleanup interval: ${config.cleanupIntervalMs / 1000} seconds\n`);
});

// --- Start the cleanup scheduler ---
// Layer 2: periodically delete expired files.
const cleanupInterval = cleanup.startScheduler(config.cleanupIntervalMs);

// ============================================================
// Graceful shutdown
// ============================================================
// When the hosting platform sends SIGTERM (or you press Ctrl+C
// which sends SIGINT), we:
//   1. Stop accepting new connections
//   2. Wait for in-flight requests to finish
//   3. Close the database pool
//   4. Exit cleanly
//
// This prevents data corruption and connection leaks.
// ============================================================

function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down gracefully...`);

    // Stop the cleanup scheduler
    clearInterval(cleanupInterval);

    // Stop the HTTP server (no new connections)
    server.close(async () => {
        console.log('HTTP server closed.');

        // Close all database connections
        try {
            await db.close();
            console.log('Database pool closed.');
        } catch (err) {
            console.error('Error closing database pool:', err.message);
        }

        console.log('Goodbye! 👋');
        process.exit(0);
    });

    // If the server hasn't closed in 10 seconds, force exit.
    // This prevents the process from hanging indefinitely.
    setTimeout(() => {
        console.error('Forced shutdown after timeout.');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
