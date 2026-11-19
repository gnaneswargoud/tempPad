// ============================================================
// TempPad — Slug validation utility
// ============================================================
// This module contains ALL the slug validation logic in one place.
// It is used by:
//   1. The validateSlug middleware (backend)
//   2. The frontend JavaScript (the same regex is duplicated there
//      because we cannot share CommonJS modules with the browser;
//      a comment in the frontend references this file as the source of truth)
// ============================================================

'use strict';

// Allowed pattern: 1-64 lowercase letters, digits, hyphens, underscores.
// The slug is normalized to lowercase BEFORE this check.
const SLUG_REGEX = /^[a-z0-9_-]{1,64}$/;

// Names that would collide with Express routes or static file paths.
// Keep this list sorted for readability.
const RESERVED_NAMES = new Set([
    'admin',
    'api',
    'assets',
    'favicon.ico',
    'health',
    'index',
    'new',
    'robots.txt',
    'static',
]);

/**
 * Validate and normalize a slug.
 *
 * @param {string} raw - The raw slug from the URL or user input.
 * @returns {{ valid: boolean, slug?: string, error?: string }}
 *   - valid: true if the slug is acceptable
 *   - slug: the normalized (lowercased) slug (only if valid)
 *   - error: a user-friendly error message (only if invalid)
 */
function validateSlug(raw) {
    // Must be a non-empty string
    if (typeof raw !== 'string' || raw.length === 0) {
        return { valid: false, error: 'Filename cannot be empty.' };
    }

    // Decode percent-encoded characters ONCE, then validate the result.
    // This prevents tricks like %2F (/) or %00 (null byte).
    let decoded;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        return { valid: false, error: 'Filename contains invalid characters.' };
    }

    // Reject null bytes
    if (decoded.includes('\0')) {
        return { valid: false, error: 'Filename contains invalid characters.' };
    }

    // Normalize to lowercase
    const slug = decoded.toLowerCase();

    // Check length
    if (slug.length > 64) {
        return { valid: false, error: 'Filename must be 1–64 characters long.' };
    }

    // Check allowed characters
    if (!SLUG_REGEX.test(slug)) {
        return {
            valid: false,
            error: 'Filename can only contain letters, numbers, hyphens, and underscores.',
        };
    }

    // Check reserved names
    if (RESERVED_NAMES.has(slug)) {
        return { valid: false, error: `"${slug}" is a reserved name. Please choose another.` };
    }

    return { valid: true, slug };
}

module.exports = { validateSlug, SLUG_REGEX, RESERVED_NAMES };
