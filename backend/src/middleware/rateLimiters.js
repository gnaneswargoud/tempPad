// ============================================================
// TempPad — Rate limiting middleware
// ============================================================
// Three separate limiters for different operations:
//   1. File creation (strict) — prevents abuse/spam
//   2. File reads (generous) — normal browsing
//   3. File writes (moderate) — saves
//
// Each returns 429 Too Many Requests with a Retry-After header.
//
// IMPORTANT: For rate limiting to work behind a reverse proxy
// (Render, Railway, Heroku), you must:
//   1. Set TRUST_PROXY=1 in your environment variables
//   2. The app.js file calls app.set('trust proxy', 1)
// This tells Express to use the X-Forwarded-For header (set by
// the proxy) as the client's real IP instead of the proxy's IP.
// Without this, all users share one rate limit bucket.
// ============================================================

'use strict';

const rateLimit = require('express-rate-limit');

// --- File creation: strict ---
// 10 new files per IP per 15 minutes.
const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,    // Return RateLimit-* headers
    legacyHeaders: false,     // Disable X-RateLimit-* headers
    message: {
        error: 'rate_limited',
        message: 'Too many files created. Please wait before creating more.',
    },
});

// --- File reads: generous ---
// 120 reads per IP per minute.
const readLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'rate_limited',
        message: 'Too many requests. Please slow down.',
    },
});

// --- File writes: moderate ---
// 30 saves per IP per minute (autosave can be frequent).
const writeLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'rate_limited',
        message: 'Too many save requests. Please wait a moment.',
    },
});

module.exports = { createLimiter, readLimiter, writeLimiter };
