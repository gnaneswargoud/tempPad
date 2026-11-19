// ============================================================
// TempPad — Express application setup
// ============================================================
// This file configures the Express app: middleware, routes,
// static file serving, and the HTML "shell" route.
// It is exported (not started) so tests can use it with Supertest.
// The actual HTTP server is started in server.js.
// ============================================================

'use strict';

const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const config = require('./config/env');
const securityMiddleware = require('./middleware/security');
const errorHandler = require('./middleware/errorHandler');
const fileRoutes = require('./routes/files');
const healthRoutes = require('./routes/health');
const { validateSlug } = require('./utils/slug');

const app = express();

// ------------------------------------------------------------
// Trust proxy (required for rate limiting behind Render, Railway, etc.)
// When set, Express reads the client's real IP from X-Forwarded-For
// instead of seeing the proxy's IP. Without this, all users share
// one rate limit bucket.
// Set TRUST_PROXY=1 in production behind a reverse proxy.
// ------------------------------------------------------------
if (config.trustProxy) {
    app.set('trust proxy', 1);
}

// ------------------------------------------------------------
// Security headers (Helmet + CSP)
// ------------------------------------------------------------
app.use(securityMiddleware());

// ------------------------------------------------------------
// Compression (gzip responses for faster load times)
// ------------------------------------------------------------
app.use(compression());

// ------------------------------------------------------------
// CORS
// Since the frontend is served from the same Express server
// (same origin), CORS is NOT needed by default. Cross-origin
// requests are blocked.
//
// If the frontend is ever hosted separately (e.g., on a CDN),
// set CORS_ORIGIN to that origin (e.g., https://temppad.com)
// and uncomment the CORS middleware to allow it.
// ------------------------------------------------------------
if (config.corsOrigin) {
    app.use(cors({
        origin: config.corsOrigin,
        methods: ['GET', 'POST', 'PUT'],
        allowedHeaders: ['Content-Type'],
    }));
}

// ------------------------------------------------------------
// Body parsing
// Limit request body to ~300 KB to prevent abuse.
// This is slightly larger than the 200,000 character content limit
// to account for JSON overhead (keys, braces, encoding).
// ------------------------------------------------------------
app.use(express.json({ limit: '300kb' }));

// ------------------------------------------------------------
// Set Cache-Control: no-store on ALL API responses.
// This prevents browsers and proxies from caching API data,
// which is important because file content changes frequently
// and expired files must not be served from cache.
// ------------------------------------------------------------
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

// ------------------------------------------------------------
// API routes (must come before static files and the catch-all)
// ------------------------------------------------------------
app.use('/api/files', fileRoutes);
app.use('/api/health', healthRoutes);

// ------------------------------------------------------------
// Static files (frontend HTML, CSS, JS)
// Served from the frontend/public directory.
// ------------------------------------------------------------
const frontendPath = path.resolve(__dirname, '../../frontend/public');
app.use(express.static(frontendPath));

// ------------------------------------------------------------
// Landing page: GET /
// Serves the homepage (index.html).
// ------------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// ------------------------------------------------------------
// Editor page: GET /:slug
// Serves the editor HTML shell for any valid slug.
//
// IMPORTANT: This route does NOT create a database row.
// The frontend JavaScript calls POST /api/files/:slug after
// loading. This design prevents crawlers, link prefetchers,
// and browser preloads from creating junk rows in the database.
//
// If the slug is invalid, serve a 400 error page instead of
// crashing or falling through to a 404.
// ------------------------------------------------------------
app.get('/:slug', (req, res) => {
    const result = validateSlug(req.params.slug);

    if (!result.valid) {
        return res.status(400).sendFile(path.join(frontendPath, 'error.html'));
    }

    res.sendFile(path.join(frontendPath, 'editor.html'));
});

// ------------------------------------------------------------
// 404 handler: any unmatched route
// ------------------------------------------------------------
app.use((req, res) => {
    res.status(404).json({
        error: 'not_found',
        message: 'The requested resource was not found.',
    });
});

// ------------------------------------------------------------
// Central error handler (must be last)
// ------------------------------------------------------------
app.use(errorHandler);

module.exports = app;
