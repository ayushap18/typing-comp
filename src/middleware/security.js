/**
 * Security Middleware and Utilities
 * Provides comprehensive security measures for the typing competition platform
 * @module middleware/security
 */

const crypto = require('crypto');
const logger = require('../config/logger');

/**
 * Security headers middleware
 * Adds various security headers to responses
 */
const securityHeaders = (req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Enable XSS filter
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Permissions policy
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  
  // Content Security Policy
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' https:",
    "connect-src 'self' wss: ws:",
    "frame-ancestors 'none'"
  ].join('; '));

  next();
};

/**
 * Generate a secure random token
 * @param {number} length - Token length in bytes
 * @returns {string} Hex encoded token
 */
const generateSecureToken = (length = 32) => {
  return crypto.randomBytes(length).toString('hex');
};

/**
 * Generate a secure competition code
 * @returns {string} 5 character alphanumeric code
 */
const generateCompetitionCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  const randomBytes = crypto.randomBytes(5);
  
  for (let i = 0; i < 5; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  
  return code;
};

/**
 * Hash sensitive data using SHA-256
 * @param {string} data - Data to hash
 * @param {string} salt - Optional salt
 * @returns {string} Hashed data
 */
const hashData = (data, salt = '') => {
  return crypto
    .createHash('sha256')
    .update(data + salt)
    .digest('hex');
};

/**
 * CSRF token generation and validation
 */
class CSRFProtection {
  constructor(options = {}) {
    this.tokenLength = options.tokenLength || 32;
    this.headerName = options.headerName || 'x-csrf-token';
    this.cookieName = options.cookieName || '_csrf';
    this.tokens = new Map();
    
    // Cleanup expired tokens every 10 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 600000);
  }

  /**
   * Generate a new CSRF token for a session
   * @param {string} sessionId - Session identifier
   * @returns {string} CSRF token
   */
  generateToken(sessionId) {
    const token = generateSecureToken(this.tokenLength);
    
    this.tokens.set(sessionId, {
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000 // 1 hour
    });
    
    return token;
  }

  /**
   * Validate a CSRF token
   * @param {string} sessionId - Session identifier
   * @param {string} token - Token to validate
   * @returns {boolean} True if valid
   */
  validateToken(sessionId, token) {
    const stored = this.tokens.get(sessionId);
    
    if (!stored) return false;
    if (Date.now() > stored.expiresAt) {
      this.tokens.delete(sessionId);
      return false;
    }
    
    return crypto.timingSafeEqual(
      Buffer.from(stored.token),
      Buffer.from(token)
    );
  }

  /**
   * Cleanup expired tokens
   */
  cleanup() {
    const now = Date.now();
    for (const [sessionId, data] of this.tokens.entries()) {
      if (now > data.expiresAt) {
        this.tokens.delete(sessionId);
      }
    }
  }

  /**
   * Express middleware for CSRF protection
   */
  middleware() {
    return (req, res, next) => {
      // Skip for GET, HEAD, OPTIONS requests
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
      }

      const sessionId = req.sessionID || req.cookies?.sessionId || req.ip;
      const token = req.headers[this.headerName] || req.body?._csrf;

      if (!token || !this.validateToken(sessionId, token)) {
        logger.warn('CSRF validation failed', {
          ip: req.ip,
          path: req.path,
          method: req.method
        });
        
        return res.status(403).json({
          success: false,
          error: 'Invalid or missing CSRF token'
        });
      }

      next();
    };
  }

  /**
   * Destroy the cleanup interval
   */
  destroy() {
    clearInterval(this.cleanupInterval);
  }
}

/**
 * IP-based request tracking for suspicious activity detection
 */
class SuspiciousActivityDetector {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 3600000; // 1 hour
    this.maxFailedAttempts = options.maxFailedAttempts || 10;
    this.blockDuration = options.blockDuration || 3600000; // 1 hour
    this.activity = new Map();
    this.blocked = new Map();
    
    // Cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
  }

  /**
   * Record an activity event
   * @param {string} ip - IP address
   * @param {string} type - Activity type
   * @param {boolean} success - Whether the activity was successful
   */
  recordActivity(ip, type, success = true) {
    const key = `${ip}:${type}`;
    const now = Date.now();
    
    let data = this.activity.get(key) || {
      attempts: [],
      failedAttempts: 0
    };

    // Filter out old attempts
    data.attempts = data.attempts.filter(t => now - t < this.windowMs);
    data.attempts.push(now);

    if (!success) {
      data.failedAttempts++;
      
      // Check if should be blocked
      if (data.failedAttempts >= this.maxFailedAttempts) {
        this.blockIP(ip, `Too many failed ${type} attempts`);
      }
    } else {
      // Reset failed attempts on success
      data.failedAttempts = 0;
    }

    this.activity.set(key, data);
  }

  /**
   * Block an IP address
   * @param {string} ip - IP address to block
   * @param {string} reason - Reason for blocking
   */
  blockIP(ip, reason) {
    this.blocked.set(ip, {
      blockedAt: Date.now(),
      expiresAt: Date.now() + this.blockDuration,
      reason
    });

    logger.warn('IP blocked', { ip, reason });
  }

  /**
   * Check if an IP is blocked
   * @param {string} ip - IP address to check
   * @returns {boolean} True if blocked
   */
  isBlocked(ip) {
    const blockData = this.blocked.get(ip);
    
    if (!blockData) return false;
    
    if (Date.now() > blockData.expiresAt) {
      this.blocked.delete(ip);
      return false;
    }
    
    return true;
  }

  /**
   * Express middleware to check for blocked IPs
   */
  middleware() {
    return (req, res, next) => {
      const ip = req.ip || req.connection?.remoteAddress;
      
      if (this.isBlocked(ip)) {
        const blockData = this.blocked.get(ip);
        const remainingTime = Math.ceil((blockData.expiresAt - Date.now()) / 1000);
        
        logger.warn('Blocked IP attempted access', { ip, path: req.path });
        
        return res.status(403).json({
          success: false,
          error: 'Your IP has been temporarily blocked due to suspicious activity',
          retryAfter: remainingTime
        });
      }
      
      next();
    };
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    
    for (const [key, data] of this.activity.entries()) {
      data.attempts = data.attempts.filter(t => now - t < this.windowMs);
      if (data.attempts.length === 0) {
        this.activity.delete(key);
      }
    }
    
    for (const [ip, data] of this.blocked.entries()) {
      if (now > data.expiresAt) {
        this.blocked.delete(ip);
      }
    }
  }

  /**
   * Destroy cleanup interval
   */
  destroy() {
    clearInterval(this.cleanupInterval);
  }
}

/**
 * Detect and prevent timing attacks on authentication
 * @param {Function} compareFunction - Comparison function
 * @returns {Function} Safe comparison function
 */
const safeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(a),
      Buffer.from(b.padEnd(a.length))
    );
  } catch {
    return false;
  }
};

/**
 * Sanitize error messages for client responses
 * Prevents information leakage
 * @param {Error} error - Error object
 * @returns {object} Sanitized error response
 */
const sanitizeErrorResponse = (error) => {
  // List of sensitive error patterns to hide
  const sensitivePatterns = [
    /password/i,
    /token/i,
    /secret/i,
    /key/i,
    /database/i,
    /mongo/i,
    /connection/i,
    /auth/i
  ];

  const message = error.message || 'An error occurred';
  
  for (const pattern of sensitivePatterns) {
    if (pattern.test(message)) {
      return {
        success: false,
        error: 'An internal error occurred. Please try again later.'
      };
    }
  }

  return {
    success: false,
    error: message
  };
};

/**
 * Validate and sanitize socket.io connection data
 * @param {object} socket - Socket.io socket
 * @returns {boolean} True if connection is valid
 */
const validateSocketConnection = (socket) => {
  const { handshake } = socket;
  
  // Check origin
  const origin = handshake.headers.origin;
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
  
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
    logger.warn('Socket connection rejected - invalid origin', { 
      origin, 
      socketId: socket.id 
    });
    return false;
  }

  // Check for required headers
  if (!handshake.headers['user-agent']) {
    logger.warn('Socket connection rejected - missing user agent', { 
      socketId: socket.id 
    });
    return false;
  }

  return true;
};

/**
 * Request fingerprinting for additional security
 * @param {object} req - Express request
 * @returns {string} Request fingerprint
 */
const generateRequestFingerprint = (req) => {
  const components = [
    req.ip,
    req.headers['user-agent'] || '',
    req.headers['accept-language'] || '',
    req.headers['accept-encoding'] || ''
  ];
  
  return hashData(components.join('|'));
};

/**
 * Detect potential bot/automated requests
 * @param {object} req - Express request
 * @returns {boolean} True if likely automated
 */
const detectAutomatedRequest = (req) => {
  const userAgent = req.headers['user-agent'] || '';
  
  // Known bot patterns
  const botPatterns = [
    /bot/i,
    /crawler/i,
    /spider/i,
    /scraper/i,
    /curl/i,
    /wget/i,
    /python-requests/i,
    /axios/i
  ];

  for (const pattern of botPatterns) {
    if (pattern.test(userAgent)) {
      return true;
    }
  }

  // Check for missing common headers
  if (!req.headers['accept'] || !req.headers['accept-language']) {
    return true;
  }

  return false;
};

// Create instances for export
const csrfProtection = new CSRFProtection();
const activityDetector = new SuspiciousActivityDetector();

module.exports = {
  securityHeaders,
  generateSecureToken,
  generateCompetitionCode,
  hashData,
  CSRFProtection,
  csrfProtection,
  SuspiciousActivityDetector,
  activityDetector,
  safeCompare,
  sanitizeErrorResponse,
  validateSocketConnection,
  generateRequestFingerprint,
  detectAutomatedRequest
};
