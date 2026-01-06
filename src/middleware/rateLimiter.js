/**
 * Rate Limiting Middleware
 * Provides comprehensive rate limiting to prevent abuse and ensure fair usage
 * @module middleware/rateLimiter
 */

const logger = require('../config/logger');

/**
 * In-memory store for rate limiting
 * In production, consider using Redis for distributed rate limiting
 */
class RateLimitStore {
  constructor() {
    this.store = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Cleanup every minute
  }

  /**
   * Get current count for a key
   * @param {string} key - Rate limit key
   * @returns {object} Current count and reset time
   */
  get(key) {
    const data = this.store.get(key);
    if (!data) return null;
    
    if (Date.now() > data.resetTime) {
      this.store.delete(key);
      return null;
    }
    
    return data;
  }

  /**
   * Increment count for a key
   * @param {string} key - Rate limit key
   * @param {number} windowMs - Time window in milliseconds
   * @returns {object} Updated count data
   */
  increment(key, windowMs) {
    const existing = this.get(key);
    
    if (existing) {
      existing.count++;
      this.store.set(key, existing);
      return existing;
    }
    
    const data = {
      count: 1,
      resetTime: Date.now() + windowMs,
      firstRequest: Date.now()
    };
    
    this.store.set(key, data);
    return data;
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, data] of this.store.entries()) {
      if (now > data.resetTime) {
        this.store.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`Rate limiter cleanup: removed ${cleaned} expired entries`);
    }
  }

  /**
   * Clear all entries (useful for testing)
   */
  clear() {
    this.store.clear();
  }

  /**
   * Stop the cleanup interval
   */
  destroy() {
    clearInterval(this.cleanupInterval);
  }
}

// Shared store instance
const store = new RateLimitStore();

/**
 * Generate rate limit key from request
 * @param {object} req - Express request object
 * @param {string} prefix - Key prefix
 * @returns {string} Rate limit key
 */
const generateKey = (req, prefix = 'rl') => {
  const ip = req.ip || 
             req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
             req.connection?.remoteAddress ||
             'unknown';
  
  return `${prefix}:${ip}`;
};

/**
 * Create rate limiter middleware
 * @param {object} options - Rate limiter options
 * @returns {Function} Express middleware
 */
const createRateLimiter = (options = {}) => {
  const {
    windowMs = 60000,           // 1 minute default window
    maxRequests = 100,          // 100 requests per window
    message = 'Too many requests, please try again later',
    statusCode = 429,
    keyGenerator = generateKey,
    keyPrefix = 'rl',
    skipFailedRequests = false,
    skipSuccessfulRequests = false,
    handler = null,
    skip = null
  } = options;

  return (req, res, next) => {
    // Check if this request should be skipped
    if (skip && typeof skip === 'function' && skip(req)) {
      return next();
    }

    const key = keyGenerator(req, keyPrefix);
    const data = store.increment(key, windowMs);

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - data.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(data.resetTime / 1000));

    // Check if limit exceeded
    if (data.count > maxRequests) {
      const retryAfter = Math.ceil((data.resetTime - Date.now()) / 1000);
      res.setHeader('Retry-After', retryAfter);

      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        count: data.count,
        limit: maxRequests
      });

      if (handler && typeof handler === 'function') {
        return handler(req, res, next);
      }

      return res.status(statusCode).json({
        success: false,
        error: message,
        retryAfter
      });
    }

    // Handle response tracking for skipFailedRequests/skipSuccessfulRequests
    if (skipFailedRequests || skipSuccessfulRequests) {
      const originalEnd = res.end;
      res.end = function(...args) {
        const shouldSkip = (skipFailedRequests && res.statusCode >= 400) ||
                          (skipSuccessfulRequests && res.statusCode < 400);
        
        if (shouldSkip) {
          const currentData = store.get(key);
          if (currentData && currentData.count > 0) {
            currentData.count--;
            store.store.set(key, currentData);
          }
        }
        
        return originalEnd.apply(this, args);
      };
    }

    next();
  };
};

/**
 * Pre-configured rate limiters for different endpoints
 */

// General API rate limiter
const apiLimiter = createRateLimiter({
  windowMs: 60000,      // 1 minute
  maxRequests: 100,     // 100 requests per minute
  keyPrefix: 'api',
  message: 'Too many API requests, please slow down'
});

// Strict limiter for authentication endpoints
const authLimiter = createRateLimiter({
  windowMs: 900000,     // 15 minutes
  maxRequests: 10,      // 10 attempts per 15 minutes
  keyPrefix: 'auth',
  message: 'Too many authentication attempts, please try again in 15 minutes'
});

// Competition creation limiter
const competitionCreateLimiter = createRateLimiter({
  windowMs: 3600000,    // 1 hour
  maxRequests: 10,      // 10 competitions per hour
  keyPrefix: 'comp-create',
  message: 'Too many competitions created, please wait an hour'
});

// Competition join limiter
const competitionJoinLimiter = createRateLimiter({
  windowMs: 60000,      // 1 minute
  maxRequests: 5,       // 5 join attempts per minute
  keyPrefix: 'comp-join',
  message: 'Too many join attempts, please wait a moment'
});

// Socket event rate limiter (for typing updates)
const socketEventLimiter = createRateLimiter({
  windowMs: 1000,       // 1 second
  maxRequests: 20,      // 20 events per second (typing updates are frequent)
  keyPrefix: 'socket',
  message: 'Event rate limit exceeded'
});

// Registration rate limiter
const registrationLimiter = createRateLimiter({
  windowMs: 3600000,    // 1 hour
  maxRequests: 3,       // 3 registration attempts per hour
  keyPrefix: 'register',
  message: 'Too many registration attempts, please try again later'
});

/**
 * Socket.io rate limiting middleware
 * @param {object} socket - Socket.io socket
 * @param {string} eventName - Event name for rate limiting
 * @param {object} options - Rate limit options
 * @returns {boolean} Whether the event should be allowed
 */
const socketRateLimit = (socket, eventName, options = {}) => {
  const {
    windowMs = 1000,
    maxRequests = 10
  } = options;

  const key = `socket:${socket.id}:${eventName}`;
  const data = store.increment(key, windowMs);

  if (data.count > maxRequests) {
    logger.warn('Socket rate limit exceeded', {
      socketId: socket.id,
      event: eventName,
      count: data.count
    });
    return false;
  }

  return true;
};

/**
 * Sliding window rate limiter for more precise control
 * @param {object} options - Rate limiter options
 * @returns {Function} Express middleware
 */
const slidingWindowLimiter = (options = {}) => {
  const {
    windowMs = 60000,
    maxRequests = 100,
    keyPrefix = 'sw'
  } = options;

  const windows = new Map();

  return (req, res, next) => {
    const key = generateKey(req, keyPrefix);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Get or create window data
    let windowData = windows.get(key) || [];
    
    // Remove expired timestamps
    windowData = windowData.filter(timestamp => timestamp > windowStart);
    
    // Check limit
    if (windowData.length >= maxRequests) {
      const oldestRequest = Math.min(...windowData);
      const retryAfter = Math.ceil((oldestRequest + windowMs - now) / 1000);
      
      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', 0);
      
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        retryAfter
      });
    }

    // Add current request timestamp
    windowData.push(now);
    windows.set(key, windowData);

    // Set headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', maxRequests - windowData.length);

    next();
  };
};

module.exports = {
  RateLimitStore,
  createRateLimiter,
  generateKey,
  apiLimiter,
  authLimiter,
  competitionCreateLimiter,
  competitionJoinLimiter,
  socketEventLimiter,
  registrationLimiter,
  socketRateLimit,
  slidingWindowLimiter,
  store
};
