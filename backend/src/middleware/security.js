// ============================================================
// TempPad — Security middleware (Helmet + CSP)
// ============================================================
// Configures Helmet for secure HTTP headers, including a strict
// Content-Security-Policy that forbids inline scripts.
// The frontend must load all JS from external files (no inline).
// ============================================================

'use strict';

const helmet = require('helmet');

/**
 * Returns a configured Helmet middleware.
 *
 * Content-Security-Policy breakdown:
 *   default-src 'self'    — only load resources from the same origin
 *   script-src  'self'    — only load scripts from our own static files
 *   style-src   'self'    — only load stylesheets from our own static files
 *   img-src     'self' data: — allow images from same origin and data: URIs
 *   font-src    'self'    — only load fonts from same origin
 *   connect-src 'self'    — only allow fetch/XHR to same origin (our API)
 *   form-action 'self'    — forms can only submit to same origin
 *   frame-ancestors 'none' — prevent embedding in iframes (clickjacking)
 *   base-uri    'self'    — restrict <base> tag
 *   object-src  'none'    — block <object>, <embed>, <applet>
 */
function securityMiddleware() {
    return helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc:  ["'self'"],
                styleSrc:   ["'self'"],
                imgSrc:     ["'self'", 'data:'],
                fontSrc:    ["'self'"],
                connectSrc: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                baseUri:    ["'self'"],
                objectSrc:  ["'none'"],
            },
        },
        // These are enabled by default in Helmet, listed for clarity:
        crossOriginEmbedderPolicy: false, // Can block some resources; disable for simplicity
    });
}

module.exports = securityMiddleware;
