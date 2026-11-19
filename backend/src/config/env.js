// ============================================================
// TempPad — Environment variable loader and validator
// ============================================================
// Loads .env in development, then validates that all required
// variables are present. The server refuses to start if any
// required variable is missing (fail-fast principle).
// ============================================================

'use strict';

const path = require('path');

// In development, load .env from the project root.
// In production, environment variables are set by the hosting platform.
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
}

/**
 * Validate and export all configuration values.
 * Each value has a default where safe, or throws if required and missing.
 */
function loadConfig() {
    const config = {
        // --- Required ---
        databaseUrl: process.env.DATABASE_URL,

        // --- Optional with defaults ---
        port:              parseInt(process.env.PORT, 10) || 3000,
        nodeEnv:           process.env.NODE_ENV || 'development',
        trustProxy:        process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
        fileTtlSeconds:    parseInt(process.env.FILE_TTL_SECONDS, 10) || 86400,
        cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS, 10) || 300000,
        corsOrigin:        process.env.CORS_ORIGIN || '',
        dbSsl:             process.env.DB_SSL === 'true',
    };

    // --- Fail-fast validation ---
    if (!config.databaseUrl) {
        console.error(
            '\n❌  DATABASE_URL is not set.\n' +
            '   Copy .env.example to .env and set your PostgreSQL connection string.\n' +
            '   Example: DATABASE_URL=postgresql://temppad_user:password@localhost:5432/temppad\n'
        );
        process.exit(1);
    }

    if (config.fileTtlSeconds < 10) {
        console.error('❌  FILE_TTL_SECONDS must be at least 10.');
        process.exit(1);
    }

    return config;
}

module.exports = loadConfig();
