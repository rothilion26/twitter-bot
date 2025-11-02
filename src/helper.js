const fs = require('fs-extra');
const path = require('path');

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate random number between min and max (inclusive)
 */
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Random delay between min and max milliseconds
 */
async function randomDelay(min, max) {
  const delay = randomBetween(min, max);
  await sleep(delay);
  return delay;
}

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateBackoff(attempt) {
  const baseDelay = 1000;
  const maxDelay = 60000;
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = randomBetween(0, exponentialDelay * 0.3);
  return exponentialDelay + jitter;
}

/**
 * Log message with timestamp to both file and console
 */
async function logMessage(message, logFile) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  
  console.log(`[${timestamp}] ${message}`);
  
  try {
    await fs.appendFile(logFile, logEntry, 'utf8');
  } catch (error) {
    console.error(`Failed to write to log file: ${error.message}`);
  }
}

/**
 * Extract stable tweet ID from tweet element
 * Tries to find status URL and extract the ID
 */
function findTweetId(tweetElement) {
  try {
    // Try to find status link within the tweet
    const statusLink = tweetElement.querySelector('a[href*="/status/"]');
    if (statusLink) {
      const href = statusLink.getAttribute('href');
      const match = href.match(/\/status\/(\d+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    // Fallback: try data-testid="tweet" and extract from aria-label or other attributes
    const tweet = tweetElement.closest('[data-testid="tweet"]') || tweetElement;
    if (tweet) {
      // Try to extract from any link that might contain the status ID
      const allLinks = tweet.querySelectorAll('a[href*="/status/"]');
      for (const link of allLinks) {
        const href = link.getAttribute('href');
        const match = href.match(/\/status\/(\d+)/);
        if (match && match[1]) {
          return match[1];
        }
      }
    }
    
    // Last resort: use element position or a hash of content
    // This is less reliable but better than nothing
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Find like button within tweet element using multiple selector strategies
 */
async function findLikeButton(page, tweetElement) {
  const selectors = [
    '[data-testid="like"]',
    'div[data-testid="like"]',
    'svg[aria-label="Like"]',
    'div[aria-label="Like"]',
    'button[aria-label="Like"]',
    '[aria-label*="Like" i]',
  ];
  
  // First try selectors within the tweet context
  for (const selector of selectors) {
    try {
      const button = tweetElement.querySelector(selector);
      if (button) {
        // Verify it's clickable and visible
        const isVisible = await page.evaluate((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }, button);
        
        if (isVisible) {
          return button;
        }
      }
    } catch (error) {
      // Continue to next selector
    }
  }
  
  // Fallback: search for buttons with "like" in aria-label within tweet context
  try {
    const buttons = tweetElement.querySelectorAll('button, [role="button"]');
    for (const button of buttons) {
      const ariaLabel = button.getAttribute('aria-label') || '';
      if (ariaLabel.toLowerCase().includes('like')) {
        const isVisible = await page.evaluate((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }, button);
        
        if (isVisible) {
          return button;
        }
      }
    }
  } catch (error) {
    // No button found
  }
  
  return null;
}

/**
 * Check if page shows login required
 */
async function isLoginPage(page) {
  try {
    const url = page.url();
    if (url.includes('/i/flow/login') || url.includes('/login') || url.includes('/account/access')) {
      return true;
    }
    
    // Check for login-specific elements
    const loginIndicators = [
      'input[autocomplete="username"]',
      'input[name="text"]',
      '[data-testid="loginButton"]',
      'text="Sign in to X"',
    ];
    
    for (const selector of loginIndicators) {
      try {
        const element = await page.$(selector);
        if (element) {
          return true;
        }
      } catch (error) {
        // Continue
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Check if rate limited by examining page content and responses
 */
async function isRateLimited(page) {
  try {
    // Check for HTTP 429 in recent responses (if accessible)
    const response = page.response ? await page.response() : null;
    if (response && response.status() === 429) {
      return true;
    }
    
    // Check for rate limit UI indicators
    const rateLimitIndicators = [
      'rate limit',
      'try again later',
      'too many requests',
      'temporarily unavailable',
      'you are being rate limited',
    ];
    
    const pageText = await page.textContent('body').catch(() => '');
    const lowerText = pageText.toLowerCase();
    
    for (const indicator of rateLimitIndicators) {
      if (lowerText.includes(indicator)) {
        return true;
      }
    }
    
    // Check for specific rate limit error elements
    const errorSelectors = [
      '[data-testid="error"]',
      '.error',
      '[role="alert"]',
    ];
    
    for (const selector of errorSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const text = await element.textContent().catch(() => '');
          if (rateLimitIndicators.some(ind => text.toLowerCase().includes(ind))) {
            return true;
          }
        }
      } catch (error) {
        // Continue
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

module.exports = {
  sleep,
  randomBetween,
  randomDelay,
  calculateBackoff,
  logMessage,
  findTweetId,
  findLikeButton,
  isLoginPage,
  isRateLimited,
};

