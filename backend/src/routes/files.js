// ============================================================
// TempPad — File API routes
// ============================================================
// Handles all CRUD operations for temporary text files.
// Route handlers are kept thin: they parse HTTP requests, call
// the service layer, and format HTTP responses. All SQL and
// business logic lives in services/fileService.js.
// ============================================================

'use strict';

const express = require('express');
const router = express.Router();
const fileService = require('../services/fileService');
const validateSlug = require('../middleware/validateSlug');
const { createLimiter, readLimiter, writeLimiter } = require('../middleware/rateLimiters');

// ------------------------------------------------------------
// Helper: attach server_time to every response so the frontend
// can compute a clock offset for the expiry countdown.
// ------------------------------------------------------------
function addServerTime(data, serverTime) {
    return { ...data, server_time: serverTime };
}

// ------------------------------------------------------------
// POST /api/files/:slug — Open or create a file (idempotent)
// ------------------------------------------------------------
// Why POST and not GET?
// A GET request from a crawler, link prefetcher, or browser
// preload would silently create database rows for every URL it
// visits. By requiring POST, the frontend must explicitly call
// this endpoint after the page loads, so only real user visits
// create files. The HTML shell (GET /:slug) is served without
// touching the database.
// ------------------------------------------------------------
router.post('/:slug', createLimiter, validateSlug, async (req, res, next) => {
    try {
        const result = await fileService.openOrCreate(req.slug);
        const serverTime = await fileService.getServerTime();

        if (!result) {
            // Extremely rare: row vanished between INSERT and SELECT
            return res.status(500).json({
                error: 'server_error',
                message: 'Could not create the file. Please try again.',
            });
        }

        if (result.expired) {
            return res.status(410).json(
                addServerTime({ error: 'expired', slug: req.slug }, serverTime)
            );
        }

        const status = result.created ? 201 : 200;
        res.status(status).json(
            addServerTime({
                slug: result.file.slug,
                content: result.file.content,
                revision: result.file.revision,
                created_at: result.file.created_at,
                expires_at: result.file.expires_at,
                updated_at: result.file.updated_at,
                created: result.created,
            }, serverTime)
        );
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------------------
// GET /api/files/:slug — Read a file
// ------------------------------------------------------------
// Supports a lightweight "has it changed?" check:
//   GET /api/files/hello?since_revision=3
// If the file's revision is still 3, returns { changed: false }
// instead of the full content. This makes polling cheap.
// ------------------------------------------------------------
router.get('/:slug', readLimiter, validateSlug, async (req, res, next) => {
    try {
        const sinceRevision = parseInt(req.query.since_revision, 10);
        const serverTime = await fileService.getServerTime();

        // If the client sent ?since_revision=N, do a lightweight check.
        if (!isNaN(sinceRevision) && sinceRevision > 0) {
            const checkResult = await fileService.checkRevision(req.slug, sinceRevision);

            if (!checkResult) {
                return res.status(404).json(
                    addServerTime({ error: 'not_found', message: 'File not found.' }, serverTime)
                );
            }

            if (checkResult.expired) {
                return res.status(410).json(
                    addServerTime({ error: 'expired', slug: req.slug }, serverTime)
                );
            }

            if (!checkResult.changed) {
                return res.status(200).json(
                    addServerTime({ changed: false }, serverTime)
                );
            }

            // Changed — return full data
            return res.status(200).json(
                addServerTime({
                    changed: true,
                    slug: checkResult.file.slug,
                    content: checkResult.file.content,
                    revision: checkResult.file.revision,
                    created_at: checkResult.file.created_at,
                    expires_at: checkResult.file.expires_at,
                    updated_at: checkResult.file.updated_at,
                }, serverTime)
            );
        }

        // Full fetch (no since_revision)
        const result = await fileService.getBySlug(req.slug);

        if (!result) {
            return res.status(404).json(
                addServerTime({ error: 'not_found', message: 'File not found.' }, serverTime)
            );
        }

        if (result.expired) {
            return res.status(410).json(
                addServerTime({ error: 'expired', slug: req.slug }, serverTime)
            );
        }

        res.status(200).json(
            addServerTime({
                slug: result.file.slug,
                content: result.file.content,
                revision: result.file.revision,
                created_at: result.file.created_at,
                expires_at: result.file.expires_at,
                updated_at: result.file.updated_at,
            }, serverTime)
        );
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------------------
// PUT /api/files/:slug — Save content
// ------------------------------------------------------------
// Uses optimistic concurrency control (compare-and-swap):
// the client sends base_revision with every save. If someone
// else saved first, the revision won't match and we return 409
// with the latest content so the client can resolve the conflict.
// ------------------------------------------------------------
router.put('/:slug', writeLimiter, validateSlug, async (req, res, next) => {
    try {
        const { content, base_revision } = req.body;
        const serverTime = await fileService.getServerTime();

        // --- Input validation ---

        // content must be a string
        if (typeof content !== 'string') {
            return res.status(400).json({
                error: 'invalid_body',
                message: 'Content must be a string.',
            });
        }

        // Content size limit (200,000 chars, matching the DB constraint)
        if (content.length > 200000) {
            return res.status(413).json({
                error: 'content_too_large',
                message: 'Content exceeds the 200,000 character limit.',
            });
        }

        // base_revision must be a positive integer
        const revision = parseInt(base_revision, 10);
        if (isNaN(revision) || revision < 1) {
            return res.status(400).json({
                error: 'invalid_body',
                message: 'base_revision must be a positive integer.',
            });
        }

        // --- Save ---
        const result = await fileService.saveContent(req.slug, content, revision);

        if (!result) {
            return res.status(404).json(
                addServerTime({ error: 'not_found', message: 'File not found.' }, serverTime)
            );
        }

        if (result.expired) {
            return res.status(410).json(
                addServerTime({ error: 'expired', slug: req.slug }, serverTime)
            );
        }

        if (result.conflict) {
            // 409 Conflict: return the latest content and revision
            // so the client can show a conflict-resolution dialog.
            return res.status(409).json(
                addServerTime({
                    error: 'conflict',
                    message: 'Someone else saved this file. Please resolve the conflict.',
                    slug: result.file.slug,
                    content: result.file.content,
                    revision: result.file.revision,
                    created_at: result.file.created_at,
                    expires_at: result.file.expires_at,
                    updated_at: result.file.updated_at,
                }, serverTime)
            );
        }

        // Success
        res.status(200).json(
            addServerTime({
                slug: result.file.slug,
                content: result.file.content,
                revision: result.file.revision,
                created_at: result.file.created_at,
                expires_at: result.file.expires_at,
                updated_at: result.file.updated_at,
            }, serverTime)
        );
    } catch (err) {
        next(err);
    }
});

// ------------------------------------------------------------
// DELETE /api/files/:slug — NOT IMPLEMENTED
// ------------------------------------------------------------
// Public deletion is not exposed because anyone with the URL
// could delete anyone else's file. Implementing it properly
// requires ownership (password, user accounts, or a secret
// delete token generated at creation). For now, users "clear"
// a file by saving empty content via PUT, which is safe because
// the file still expires on schedule.
//
// Future: add a "delete_token" column returned only at creation,
// and require it in a DELETE request.
// ------------------------------------------------------------

module.exports = router;
