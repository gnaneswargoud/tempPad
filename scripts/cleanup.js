// ============================================================
// TempPad — Standalone cleanup script (Layer 3)
// ============================================================
// Deletes all expired files and exits.
//
// Run with: npm run cleanup
// Or schedule as an external cron job:
//   */5 * * * * cd /path/to/tempad && node scripts/cleanup.js
//
// This is Layer 3 of the expiration system. It is safe to run:
//   - From multiple server instances simultaneously
//   - While the main server is running
//   - As a cron job on a hosting provider
//
// The DELETE query is idempotent: if another process already
// deleted the expired rows, this script simply finds 0 rows
// to delete. No advisory lock is needed.
// ============================================================

'use strict';

const path = require('path');
const { Pool } = require('pg');

// Load environment variables
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function cleanup() {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
        console.error('❌  DATABASE_URL is not set. Check your .env file.');
        process.exit(1);
    }

    const poolConfig = { connectionString: databaseUrl };
    if (process.env.DB_SSL === 'true') {
        poolConfig.ssl = { rejectUnauthorized: false };
    }

    const pool = new Pool(poolConfig);

    try {
        const result = await pool.query(
            'DELETE FROM files WHERE expires_at <= now()'
        );

        const count = result.rowCount;
        if (count > 0) {
            console.log(`[Cleanup] Deleted ${count} expired file(s).`);
        } else {
            console.log('[Cleanup] No expired files to delete.');
        }
    } catch (err) {
        console.error('[Cleanup] Error:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

cleanup();
