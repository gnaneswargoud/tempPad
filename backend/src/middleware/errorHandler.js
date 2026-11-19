// ============================================================
// TempPad — Central error-handling middleware
// ============================================================
// Catches all errors that reach Express and returns a consistent
// JSON response. Never leaks stack traces or SQL details to clients.
// ============================================================

'use strict';

/**
 * Express error-handling middleware (must have 4 parameters).
 * Place this AFTER all routes with app.use(errorHandler).
 */
function errorHandler(err, req, res, _next) {
    // Log the full error server-side for debugging.
    console.error('Unhandled error:', {
        method: req.method,
        url: req.originalUrl,
        code: err.code,
        message: err.message,
    });

    // Detect database connectivity issues
    const isDbConnectionError = 
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND' ||
        err.code === 'ETIMEDOUT' ||
        err.code === 'EACCES' ||
        err.code === '28P01' || // invalid password
        err.message?.includes('Connection terminated') ||
        err.message?.includes('timeout expired');

    if (isDbConnectionError) {
        return res.status(503).json({
            error: 'service_unavailable',
            message: 'Database is not reachable. Please check your PostgreSQL connection string in .env.',
        });
    }

    // Detect if database exists but table hasn't been migrated
    if (err.code === '42P01') {
        return res.status(503).json({
            error: 'database_not_migrated',
            message: 'Database table missing. Please run "npm run migrate" in your terminal.',
        });
    }

    // If a status was already set by the route handler, use it.
    const status = err.status || err.statusCode || 500;

    // Never leak internal details. Provide a generic message for 500s.
    const message = status === 500
        ? 'An unexpected error occurred. Please try again later.'
        : err.message || 'Something went wrong.';

    res.status(status).json({
        error: err.code || 'server_error',
        message,
    });
}

module.exports = errorHandler;
