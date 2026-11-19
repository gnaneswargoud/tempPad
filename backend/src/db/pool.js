// ============================================================
// TempPad — PostgreSQL connection pool
// ============================================================
// Creates a pg Pool with sensible limits and exports helpers
// for running queries and checking connectivity.
// ============================================================

'use strict';

const { Pool } = require('pg');
const config = require('../config/env');

// Build pool configuration from the DATABASE_URL.
const poolConfig = {
    connectionString: config.databaseUrl,

    // Connection pool limits (suitable for a small app on free hosting):
    max: 10,                      // Max 10 simultaneous connections
    idleTimeoutMillis: 30000,     // Close idle connections after 30 seconds
    connectionTimeoutMillis: 5000, // Fail if a connection takes > 5 seconds
};

// Managed PostgreSQL services (Render, Neon, Supabase) require SSL.
if (config.dbSsl) {
    poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

// Log pool errors (e.g., connection dropped) so they don't crash the process.
pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
});

/**
 * Run a parameterized SQL query.
 * @param {string} text  - SQL with $1, $2, ... placeholders
 * @param {any[]}  params - Values for the placeholders
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
    return pool.query(text, params);
}

/**
 * Check if the database is reachable.
 * @returns {Promise<boolean>}
 */
async function isHealthy() {
    try {
        await pool.query('SELECT 1');
        return true;
    } catch {
        return false;
    }
}

/**
 * Gracefully close all connections in the pool.
 * Called during server shutdown.
 */
async function close() {
    await pool.end();
}

module.exports = { query, isHealthy, close, pool };
