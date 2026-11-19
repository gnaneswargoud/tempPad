// ============================================================
// TempPad — Database migration script
// ============================================================
// Reads and executes the SQL migration files in order.
// Run with: npm run migrate
//
// Usage:
//   node scripts/migrate.js
//
// This script:
//   1. Connects to the database using DATABASE_URL
//   2. Reads every .sql file in database/migrations/ (sorted)
//   3. Executes each one
//   4. Exits with code 0 on success, 1 on failure
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Load environment variables (we don't use the app's config
// because this script should work before the app is running).
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function migrate() {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
        console.error('❌  DATABASE_URL is not set. Check your .env file.');
        process.exit(1);
    }

    // Build pool config
    const poolConfig = { connectionString: databaseUrl };
    if (process.env.DB_SSL === 'true') {
        poolConfig.ssl = { rejectUnauthorized: false };
    }

    const pool = new Pool(poolConfig);

    try {
        // Find all migration files, sorted by name (001_, 002_, etc.)
        const migrationsDir = path.resolve(__dirname, '../database/migrations');
        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort();

        if (files.length === 0) {
            console.log('No migration files found.');
            process.exit(0);
        }

        console.log(`Found ${files.length} migration file(s):\n`);

        for (const file of files) {
            const filePath = path.join(migrationsDir, file);
            const sql = fs.readFileSync(filePath, 'utf8');

            console.log(`  Running: ${file} ...`);
            await pool.query(sql);
            console.log(`  ✅ ${file} applied successfully.`);
        }

        console.log('\n✅ All migrations applied successfully!');
    } catch (err) {
        console.error('\n❌ Migration failed:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

migrate();
