/**
 * Input Validation Middleware and Utilities
 * Provides comprehensive validation for typing competition platform
 * @module middleware/validation
 */

const logger = require('../config/logger');

/**
 * Validation error class for consistent error handling
 */
class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.statusCode = 400;
  }
}

/**
 * Sanitize string input to prevent XSS attacks
 * @param {string} str - Input string to sanitize
 * @returns {string} Sanitized string
 */
const sanitizeString = (str) => {
  if (typeof str !== 'string') return str;
  
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim();
};

/**
 * Validate email format
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid
 */
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return typeof email === 'string' && emailRegex.test(email);
};

/**
 * Validate competition code format (5 alphanumeric characters)
 * @param {string} code - Competition code to validate
 * @returns {boolean} True if valid
 */
const isValidCompetitionCode = (code) => {
  const codeRegex = /^[A-Z0-9]{5}$/;
  return typeof code === 'string' && codeRegex.test(code.toUpperCase());
};

/**
 * Validate participant name
 * @param {string} name - Name to validate
 * @returns {boolean} True if valid
 */
const isValidParticipantName = (name) => {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length >= 2 && trimmed.length <= 50;
};

/**
 * Validate round duration (in seconds)
 * @param {number} duration - Duration to validate
 * @returns {boolean} True if valid (30 seconds to 10 minutes)
 */
const isValidDuration = (duration) => {
  const num = Number(duration);
  return !isNaN(num) && num >= 30 && num <= 600;
};

/**
 * Validate round text content
 * @param {string} text - Text content to validate
 * @returns {boolean} True if valid
 */
const isValidRoundText = (text) => {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.length >= 10 && trimmed.length <= 5000;
};

/**
 * Validate WPM (Words Per Minute) value
 * @param {number} wpm - WPM to validate
 * @returns {boolean} True if valid (0-300 WPM is realistic)
 */
const isValidWPM = (wpm) => {
  const num = Number(wpm);
  return !isNaN(num) && num >= 0 && num <= 300;
};

/**
 * Validate accuracy percentage
 * @param {number} accuracy - Accuracy to validate
 * @returns {boolean} True if valid (0-100%)
 */
const isValidAccuracy = (accuracy) => {
  const num = Number(accuracy);
  return !isNaN(num) && num >= 0 && num <= 100;
};

/**
 * Validate MongoDB ObjectId format
 * @param {string} id - ID to validate
 * @returns {boolean} True if valid
 */
const isValidObjectId = (id) => {
  const objectIdRegex = /^[a-fA-F0-9]{24}$/;
  return typeof id === 'string' && objectIdRegex.test(id);
};

/**
 * Validate difficulty level
 * @param {string} difficulty - Difficulty to validate
 * @returns {boolean} True if valid
 */
const isValidDifficulty = (difficulty) => {
  const validLevels = ['easy', 'medium', 'hard'];
  return validLevels.includes(difficulty?.toLowerCase());
};

/**
 * Middleware to validate competition creation request
 */
const validateCreateCompetition = (req, res, next) => {
  try {
    const { name, rounds, description, difficulty } = req.body;

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length < 3) {
      throw new ValidationError('Competition name must be at least 3 characters', 'name');
    }
    if (name.trim().length > 100) {
      throw new ValidationError('Competition name cannot exceed 100 characters', 'name');
    }

    // Validate rounds array
    if (!rounds || !Array.isArray(rounds) || rounds.length === 0) {
      throw new ValidationError('At least one round is required', 'rounds');
    }
    if (rounds.length > 10) {
      throw new ValidationError('Maximum 10 rounds allowed', 'rounds');
    }

    // Validate each round
    rounds.forEach((round, index) => {
      if (!isValidRoundText(round.text)) {
        throw new ValidationError(
          `Round ${index + 1}: Text must be between 10 and 5000 characters`,
          `rounds[${index}].text`
        );
      }
      if (!isValidDuration(round.duration)) {
        throw new ValidationError(
          `Round ${index + 1}: Duration must be between 30 and 600 seconds`,
          `rounds[${index}].duration`
        );
      }
    });

    // Validate optional fields
    if (description && typeof description === 'string' && description.length > 500) {
      throw new ValidationError('Description cannot exceed 500 characters', 'description');
    }

    if (difficulty && !isValidDifficulty(difficulty)) {
      throw new ValidationError('Difficulty must be easy, medium, or hard', 'difficulty');
    }

    // Sanitize inputs
    req.body.name = sanitizeString(name.trim());
    req.body.description = description ? sanitizeString(description.trim()) : '';
    req.body.rounds = rounds.map(round => ({
      ...round,
      text: round.text.trim()
    }));

    next();
  } catch (error) {
    if (error instanceof ValidationError) {
      logger.warn('Validation error in createCompetition', { 
        field: error.field, 
        message: error.message 
      });
      return res.status(400).json({
        success: false,
        error: error.message,
        field: error.field
      });
    }
    next(error);
  }
};

/**
 * Middleware to validate join competition request
 */
const validateJoinCompetition = (req, res, next) => {
  try {
    const { code, name } = req.body;

    if (!code || !isValidCompetitionCode(code)) {
      throw new ValidationError('Invalid competition code format (5 alphanumeric characters required)', 'code');
    }

    if (!name || !isValidParticipantName(name)) {
      throw new ValidationError('Participant name must be between 2 and 50 characters', 'name');
    }

    // Sanitize inputs
    req.body.code = code.toUpperCase().trim();
    req.body.name = sanitizeString(name.trim());

    next();
  } catch (error) {
    if (error instanceof ValidationError) {
      logger.warn('Validation error in joinCompetition', { 
        field: error.field, 
        message: error.message 
      });
      return res.status(400).json({
        success: false,
        error: error.message,
        field: error.field
      });
    }
    next(error);
  }
};

/**
 * Middleware to validate typing progress data
 */
const validateTypingProgress = (data) => {
  const errors = [];

  if (data.correctChars !== undefined && (typeof data.correctChars !== 'number' || data.correctChars < 0)) {
    errors.push('correctChars must be a non-negative number');
  }

  if (data.totalChars !== undefined && (typeof data.totalChars !== 'number' || data.totalChars < 0)) {
    errors.push('totalChars must be a non-negative number');
  }

  if (data.wpm !== undefined && !isValidWPM(data.wpm)) {
    errors.push('WPM must be between 0 and 300');
  }

  if (data.accuracy !== undefined && !isValidAccuracy(data.accuracy)) {
    errors.push('Accuracy must be between 0 and 100');
  }

  if (data.errors !== undefined && (typeof data.errors !== 'number' || data.errors < 0)) {
    errors.push('errors must be a non-negative number');
  }

  if (data.backspaces !== undefined && (typeof data.backspaces !== 'number' || data.backspaces < 0)) {
    errors.push('backspaces must be a non-negative number');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
};

/**
 * Middleware to validate organizer registration
 */
const validateOrganizerRegistration = (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      throw new ValidationError('Name must be at least 2 characters', 'name');
    }
    if (name.trim().length > 100) {
      throw new ValidationError('Name cannot exceed 100 characters', 'name');
    }

    if (!email || !isValidEmail(email)) {
      throw new ValidationError('Invalid email format', 'email');
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters', 'password');
    }
    if (password.length > 128) {
      throw new ValidationError('Password cannot exceed 128 characters', 'password');
    }

    // Check password strength
    const hasUppercase = /[A-Z]/.test(password);
    const hasLowercase = /[a-z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    
    if (!hasUppercase || !hasLowercase || !hasNumber) {
      throw new ValidationError(
        'Password must contain at least one uppercase letter, one lowercase letter, and one number',
        'password'
      );
    }

    // Sanitize inputs
    req.body.name = sanitizeString(name.trim());
    req.body.email = email.toLowerCase().trim();

    next();
  } catch (error) {
    if (error instanceof ValidationError) {
      logger.warn('Validation error in organizer registration', { 
        field: error.field, 
        message: error.message 
      });
      return res.status(400).json({
        success: false,
        error: error.message,
        field: error.field
      });
    }
    next(error);
  }
};

/**
 * Generic request body sanitizer middleware
 */
const sanitizeRequestBody = (req, res, next) => {
  const sanitizeObject = (obj) => {
    if (typeof obj !== 'object' || obj === null) return obj;
    
    const sanitized = Array.isArray(obj) ? [] : {};
    
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        sanitized[key] = sanitizeString(value);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  };

  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body);
  }

  next();
};

module.exports = {
  ValidationError,
  sanitizeString,
  isValidEmail,
  isValidCompetitionCode,
  isValidParticipantName,
  isValidDuration,
  isValidRoundText,
  isValidWPM,
  isValidAccuracy,
  isValidObjectId,
  isValidDifficulty,
  validateCreateCompetition,
  validateJoinCompetition,
  validateTypingProgress,
  validateOrganizerRegistration,
  sanitizeRequestBody
};
