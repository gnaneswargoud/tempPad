// ============================================================
// TempPad — Slug validation middleware
// ============================================================
// Validates the :slug route parameter before the handler runs.
// Returns 400 with a clear error if the slug is invalid.
// ============================================================

'use strict';

const { validateSlug } = require('../utils/slug');

/**
 * Express middleware that validates req.params.slug.
 * If valid, sets req.slug to the normalized (lowercase) slug.
 * If invalid, responds with 400 and a user-friendly error.
 */
function validateSlugMiddleware(req, res, next) {
    const result = validateSlug(req.params.slug);

    if (!result.valid) {
        return res.status(400).json({
            error: 'invalid_slug',
            message: result.error,
        });
    }

    // Attach the normalized slug so handlers don't repeat validation.
    req.slug = result.slug;
    next();
}

module.exports = validateSlugMiddleware;
