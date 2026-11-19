// ============================================================
// TempPad — File service (all database operations)
// ============================================================
// This is the data-access layer. ALL SQL queries for file
// operations live here, keeping route handlers thin and focused
// on HTTP concerns (parsing requests, sending responses).
//
// Every query that reads or writes a file includes:
//   expires_at > now()
// so the database clock is always the authority on expiration,
// regardless of whether the cleanup job has run.
// ============================================================

'use strict';

const db = require('../db/pool');
const config = require('../config/env');

/**
 * Open or create a file (idempotent).
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING followed by SELECT.
 * This is the atomic "upsert-read" pattern that handles the race
 * condition where two users try to create the same slug at the
 * exact same time:
 *   - Both INSERTs run; one succeeds, the other does nothing (ON CONFLICT).
 *   - The SELECT always returns the winning row.
 *   - No error is thrown, no duplicate is created.
 *
 * @param {string} slug - Normalized, validated slug.
 * @returns {Promise<{ file: object, created: boolean } | { expired: true } | null>}
 */
async function openOrCreate(slug) {
    const ttl = config.fileTtlSeconds;

    // Step 1: Try to INSERT. If the slug already exists, do nothing.
    // The expires_at is set using the database clock (now()), not JS Date.
    const insertResult = await db.query(
        `INSERT INTO files (slug, expires_at)
         VALUES ($1, now() + ($2 || ' seconds')::interval)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id, slug, content, revision, created_at, expires_at, updated_at`,
        [slug, String(ttl)]
    );

    // If INSERT succeeded, this is a brand-new file.
    if (insertResult.rows.length > 0) {
        return {
            file: insertResult.rows[0],
            created: true,
        };
    }

    // Step 2: The slug already exists. SELECT it.
    const selectResult = await db.query(
        `SELECT id, slug, content, revision, created_at, expires_at, updated_at
         FROM files
         WHERE slug = $1`,
        [slug]
    );

    if (selectResult.rows.length === 0) {
        // Extremely unlikely: the row was deleted between INSERT and SELECT.
        return null;
    }

    const row = selectResult.rows[0];

    // Check if the existing file is expired using the database clock.
    // We compare expires_at against now() in a separate query to use
    // the DB clock, not the JS clock.
    const expiryCheck = await db.query(
        `SELECT expires_at <= now() AS is_expired FROM files WHERE slug = $1`,
        [slug]
    );

    if (expiryCheck.rows.length > 0 && expiryCheck.rows[0].is_expired) {
        return { expired: true };
    }

    return {
        file: row,
        created: false,
    };
}

/**
 * Get a file by slug (read-only).
 *
 * @param {string} slug - Normalized slug.
 * @returns {Promise<{ file: object } | { expired: true } | null>}
 *   - { file } if found and not expired
 *   - { expired: true } if found but expired
 *   - null if not found at all
 */
async function getBySlug(slug) {
    const result = await db.query(
        `SELECT id, slug, content, revision, created_at, expires_at, updated_at,
                (expires_at <= now()) AS is_expired
         FROM files
         WHERE slug = $1`,
        [slug]
    );

    if (result.rows.length === 0) {
        return null; // Never existed, or already cleaned up
    }

    const row = result.rows[0];

    if (row.is_expired) {
        return { expired: true };
    }

    // Remove the computed column before returning
    delete row.is_expired;
    return { file: row };
}

/**
 * Check if a file has changed since a given revision.
 * Used for lightweight polling (the client sends its known revision).
 *
 * @param {string} slug
 * @param {number} sinceRevision
 * @returns {Promise<{ changed: boolean, file?: object } | { expired: true } | null>}
 */
async function checkRevision(slug, sinceRevision) {
    const result = await db.query(
        `SELECT id, slug, content, revision, created_at, expires_at, updated_at,
                (expires_at <= now()) AS is_expired
         FROM files
         WHERE slug = $1`,
        [slug]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const row = result.rows[0];

    if (row.is_expired) {
        return { expired: true };
    }

    delete row.is_expired;

    // If the revision hasn't changed, tell the client nothing is new.
    if (row.revision <= sinceRevision) {
        return { changed: false };
    }

    // Revision has changed — return the latest content.
    return { changed: true, file: row };
}

/**
 * Save content to a file using optimistic concurrency control.
 *
 * The "compare-and-swap" pattern:
 *   UPDATE ... WHERE slug = $slug AND revision = $base_revision AND expires_at > now()
 *
 * If 0 rows are updated, we figure out WHY:
 *   - File doesn't exist → 404
 *   - File is expired → 410
 *   - Revision mismatch → 409 (someone else saved first)
 *
 * @param {string} slug
 * @param {string} content - New content to save
 * @param {number} baseRevision - The revision the client last saw
 * @returns {Promise<{ file: object } | { conflict: true, file: object } | { expired: true } | null>}
 */
async function saveContent(slug, content, baseRevision) {
    // Atomic compare-and-swap: only succeeds if the revision matches
    // AND the file hasn't expired.
    const updateResult = await db.query(
        `UPDATE files
         SET content = $1,
             revision = revision + 1,
             updated_at = now()
         WHERE slug = $2
           AND revision = $3
           AND expires_at > now()
         RETURNING id, slug, content, revision, created_at, expires_at, updated_at`,
        [content, slug, baseRevision]
    );

    if (updateResult.rows.length > 0) {
        // Success! Return the updated row.
        return { file: updateResult.rows[0] };
    }

    // UPDATE matched 0 rows. Find out why.
    const existing = await db.query(
        `SELECT id, slug, content, revision, created_at, expires_at, updated_at,
                (expires_at <= now()) AS is_expired
         FROM files
         WHERE slug = $1`,
        [slug]
    );

    if (existing.rows.length === 0) {
        return null; // File doesn't exist → 404
    }

    const row = existing.rows[0];

    if (row.is_expired) {
        return { expired: true }; // → 410
    }

    // File exists and isn't expired, so it must be a revision mismatch → 409
    delete row.is_expired;
    return { conflict: true, file: row };
}

/**
 * Delete all expired files from the database.
 * Used by the cleanup job.
 *
 * This is safe to run from multiple server instances simultaneously
 * because DELETE is idempotent: each instance deletes whatever expired
 * rows it finds, and there's no harm if another instance already deleted
 * some of them. No advisory lock is needed for this simple pattern.
 *
 * @returns {Promise<number>} Number of rows deleted.
 */
async function deleteExpired() {
    const result = await db.query(
        `DELETE FROM files WHERE expires_at <= now()`
    );
    return result.rowCount;
}

/**
 * Re-create a file whose slug was previously used by an expired file.
 * Done in a single transaction:
 *   1. DELETE the expired row (only if it IS expired)
 *   2. INSERT a fresh row with a new 24-hour window
 *
 * The WHERE expires_at <= now() guard ensures a non-expired row
 * can NEVER be accidentally replaced.
 *
 * @param {string} slug
 * @returns {Promise<{ file: object } | { conflict: true }>}
 *   - { file } if re-created successfully
 *   - { conflict: true } if the slug is taken by a non-expired file
 */
async function recreateExpired(slug) {
    const ttl = config.fileTtlSeconds;
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // Delete ONLY if expired (atomic guard).
        const deleteResult = await client.query(
            `DELETE FROM files WHERE slug = $1 AND expires_at <= now()`,
            [slug]
        );

        if (deleteResult.rowCount === 0) {
            // The slug is either taken by a non-expired file, or doesn't exist.
            // Either way, a plain openOrCreate will handle it.
            await client.query('ROLLBACK');
            return { conflict: true };
        }

        // Insert the fresh file.
        const insertResult = await client.query(
            `INSERT INTO files (slug, expires_at)
             VALUES ($1, now() + ($2 || ' seconds')::interval)
             RETURNING id, slug, content, revision, created_at, expires_at, updated_at`,
            [slug, String(ttl)]
        );

        await client.query('COMMIT');

        return { file: insertResult.rows[0] };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Get the current database server time.
 * Used to send server_time with every API response so the frontend
 * can compute a clock offset for the expiry countdown.
 *
 * @returns {Promise<string>} ISO 8601 timestamp
 */
async function getServerTime() {
    const result = await db.query(`SELECT now() AS server_time`);
    return result.rows[0].server_time;
}

module.exports = {
    openOrCreate,
    getBySlug,
    checkRevision,
    saveContent,
    deleteExpired,
    recreateExpired,
    getServerTime,
};
