// ============================================================
// TempPad — Health check route
// ============================================================
// Returns 200 if the server AND database are reachable,
// 503 Service Unavailable otherwise.
// Used by monitoring tools and load balancers.
// ============================================================

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/pool');

router.get('/', async (req, res) => {
    const dbHealthy = await db.isHealthy();

    if (dbHealthy) {
        return res.status(200).json({
            status: 'ok',
            database: 'connected',
        });
    }

    return res.status(503).json({
        error: 'service_unavailable',
        message: 'Database is not reachable. Please try again later.',
        database: 'disconnected',
    });
});

module.exports = router;
