require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');
const { parse } = require('csv-parse/sync');
const minimist = require('minimist');
const {
  sleep,
  randomBetween,
  randomDelay,
  calculateBackoff,
  logMessage,
  isLoginPage,
  isRateLimited,
} = require('./helper');

// Parse CLI arguments
const argv = minimist(process.argv.slice(2), {
  string: ['tweets', 'rows', 'max-scan', 'daily-cap'],
  boolean: ['headless'],
  alias: {
    tweets: 't',
    rows: 'r',
    'max-scan': 'm',
    'daily-cap': 'd',
  },
});

// Load configuration with CLI overrides
const config = {
  TWEETS_TO_LIKE: parseInt(argv.tweets || process.env.TWEETS_TO_LIKE || '50', 10),
  ROWS_PER_LAUNCH: parseInt(argv.rows || process.env.ROWS_PER_LAUNCH || '1', 10),
  MAX_SCAN: parseInt(argv['max-scan'] || process.env.MAX_SCAN || '500', 10),
  DAILY_CAP: parseInt(argv['daily-cap'] || process.env.DAILY_CAP || '300', 10),
  DELAY_MIN_MS: parseInt(process.env.DELAY_MIN_MS || '1200', 10),
  DELAY_MAX_MS: parseInt(process.env.DELAY_MAX_MS || '4000', 10),
  PROXY_URL: process.env.PROXY_URL || '',
  STORAGE_STATE: process.env.STORAGE_STATE || './state.json',
  INPUT_FILE: process.env.INPUT_FILE || './input.csv',
  PROCESSED_FILE: process.env.PROCESSED_FILE || './processed.json',
  LOG_FILE: process.env.LOG_FILE || './bot.log',
  HEADLESS: argv.headless !== undefined ? argv.headless : (process.env.HEADLESS === 'true'),
  USER_AGENT: process.env.USER_AGENT || undefined,
};

// Load or initialize processed.json
async function loadProcessed() {
  const processedPath = path.resolve(config.PROCESSED_FILE);
  let processed = {
    liked: {},
    dayCount: 0,
    dayStart: '',
  };
  
  try {
    if (await fs.pathExists(processedPath)) {
      const data = await fs.readJson(processedPath);
      processed = data;
    }
  } catch (error) {
    await logMessage(`Warning: Could not read processed.json: ${error.message}`, config.LOG_FILE);
  }
  
  // Check if day has changed - reset dayCount if needed
  const today = new Date().toISOString().split('T')[0];
  if (processed.dayStart !== today) {
    await logMessage(`New day detected. Resetting dayCount from ${processed.dayCount} to 0.`, config.LOG_FILE);
    processed.dayCount = 0;
    processed.dayStart = today;
  }
  
  return processed;
}

// Save processed.json
async function saveProcessed(processed) {
  const processedPath = path.resolve(config.PROCESSED_FILE);
  try {
    await fs.writeJson(processedPath, processed, { spaces: 2 });
  } catch (error) {
    await logMessage(`Error saving processed.json: ${error.message}`, config.LOG_FILE);
  }
}

// Robust navigation helper that retries and tries twitter.com if x.com stalls
async function robustGoto(page, url, processed) {
  const maxRetries = 2;
  let lastError = null;
  
  // Try original URL first
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await logMessage(`Navigating to ${url} (attempt ${attempt + 1}/${maxRetries})...`, config.LOG_FILE);
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
      
      // Wait for main content to load
      await page.waitForSelector('main, [data-testid="primaryColumn"], article', { timeout: 60000 });
      
      const currentUrl = page.url();
      await logMessage(`Navigation successful. Current URL: ${currentUrl}`, config.LOG_FILE);
      
      await sleep(randomBetween(1000, 2000));
      return true;
    } catch (error) {
      lastError = error;
      await logMessage(`Navigation attempt ${attempt + 1} failed: ${error.message}`, config.LOG_FILE);
      
      if (attempt < maxRetries - 1) {
        const backoffDelay = calculateBackoff(attempt);
        await logMessage(`Retrying in ${Math.round(backoffDelay / 1000)}s...`, config.LOG_FILE);
        await sleep(backoffDelay);
      }
    }
  }
  
  // If x.com failed, try twitter.com as fallback
  if (url.includes('x.com')) {
    const twitterUrl = url.replace(/x\.com/g, 'twitter.com');
    await logMessage(`x.com failed, trying fallback: ${twitterUrl}`, config.LOG_FILE);
    
    try {
      await page.goto(twitterUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForSelector('main, [data-testid="primaryColumn"], article', { timeout: 60000 });
      
      const currentUrl = page.url();
      await logMessage(`Fallback navigation successful. Current URL: ${currentUrl}`, config.LOG_FILE);
      
      await sleep(randomBetween(1000, 2000));
      return true;
    } catch (error) {
      await logMessage(`Fallback navigation also failed: ${error.message}`, config.LOG_FILE);
      throw lastError || error;
    }
  }
  
  throw lastError;
}

// Collect tweet status URLs from page with scrolling
async function collectTweetIds(page, maxScan) {
  const tweetUrls = new Set(); // Use Set to avoid duplicates
  const tweetSelectors = ['[data-testid="tweet"]', 'article'];
  let lastHeight = 0;
  let noChangeCount = 0;
  const MAX_NO_CHANGE = 3;
  
  // Function to extract status URL from an element
  const extractStatusUrlFn = (element) => {
    try {
      // Try to find status link within the tweet
      const statusLink = element.querySelector('a[href*="/status/"]');
      if (statusLink) {
        const href = statusLink.href;
        if (href && href.includes('/status/')) {
          // Normalize to full URL if it's relative
          if (href.startsWith('/')) {
            return 'https://x.com' + href.split('?')[0];
          }
          // Return absolute URL without query params
          return href.split('?')[0];
        }
      }
      
      // Fallback: try all links in the tweet
      const tweet = element.closest('[data-testid="tweet"]') || element;
      if (tweet) {
        const allLinks = tweet.querySelectorAll('a[href*="/status/"]');
        for (const link of allLinks) {
          const href = link.href;
          if (href && href.includes('/status/')) {
            if (href.startsWith('/')) {
              return 'https://x.com' + href.split('?')[0];
            }
            return href.split('?')[0];
          }
        }
      }
      
      return null;
    } catch (error) {
      return null;
    }
  };
  
  await logMessage(`Starting tweet collection (max: ${maxScan})...`, config.LOG_FILE);
  
  while (tweetUrls.size < maxScan && noChangeCount < MAX_NO_CHANGE) {
    // Wait a bit for tweets to load
    await sleep(randomBetween(500, 1500));
    
    // Try to find tweets with multiple selectors
    for (const selector of tweetSelectors) {
      try {
        const elements = await page.$$(selector);
        
        for (const element of elements) {
          if (tweetUrls.size >= maxScan) break;
          
          try {
            const statusUrl = await page.evaluate(extractStatusUrlFn, element);
            if (statusUrl) {
              tweetUrls.add(statusUrl);
            }
          } catch (error) {
            // Skip this element
          }
        }
      } catch (error) {
        // Selector not found, continue
      }
    }
    
    // Scroll down
    const scrollAmount = randomBetween(200, 800);
    await page.evaluate((amount) => {
      window.scrollBy(0, amount);
    }, scrollAmount);
    
    // Check if page height changed
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === lastHeight) {
      noChangeCount++;
    } else {
      noChangeCount = 0;
      lastHeight = currentHeight;
    }
    
    // Random delay between scrolls
    await sleep(randomBetween(300, 800));
  }
  
  // Small wait after scrolling phase
  await page.waitForTimeout(800);
  
  await logMessage(`Collected ${tweetUrls.size} unique tweet URLs.`, config.LOG_FILE);
  return Array.from(tweetUrls);
}

// Like a tweet by its status URL
async function likeTweetById(page, statusUrl) {
  // Find the article that contains this status link
  const tweet = page.locator(`article:has(a[href="${statusUrl}"])`);
  
  // If exact match is not found, fallback to :has(a[href*="/status/NNN"])
  const statusId = statusUrl.split('/status/')[1]?.split('?')[0];
  const fallback = statusId ? page.locator(`article:has(a[href*="/status/${statusId}"])`) : null;
  
  const target = (await tweet.count()) ? tweet.first() : (fallback ? fallback.first() : null);
  
  // If tweet not found, return false
  if (!target || !(await target.count())) {
    return { ok: false, reason: 'tweet-not-found' };
  }
  
  // Retry logic for detached elements (up to 2 retries)
  for (let retry = 0; retry < 3; retry++) {
    try {
      // Re-query target locator fresh each time
      const freshTarget = (await tweet.count()) ? tweet.first() : (fallback ? fallback.first() : null);
      if (!freshTarget || !(await freshTarget.count())) {
        return { ok: false, reason: 'tweet-not-found' };
      }
      
      // Already liked?
      const unlike = freshTarget.locator('[data-testid="unlike"]');
      if (await unlike.first().isVisible().catch(() => false)) {
        return { ok: true, already: true };
      }
      
      // Scroll into view before clicking
      try {
        await freshTarget.scrollIntoViewIfNeeded().catch(() => {});
      } catch (error) {
        // Fallback: use evaluate to scroll
        const elementHandle = await freshTarget.elementHandle().catch(() => null);
        if (elementHandle) {
          await page.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }), elementHandle);
        }
      }
      
      // Candidate like buttons (order matters)
      const likeBtn = freshTarget.locator(
        `[data-testid="like"], div[data-testid="like"], div[role="button"][aria-label*="Like"], div[role="button"][aria-label*="Beğen"], svg[aria-label*="Like"]`
      ).first();
      
      // Ensure in view and stable
      await freshTarget.hover({ trial: true }).catch(() => {});
      await likeBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      
      // Trial click, then real click
      await likeBtn.click({ trial: true }).catch(() => {});
      await likeBtn.click({ timeout: 5000 });
      
      // After click, confirm it turned to "unlike"
      await freshTarget.locator('[data-testid="unlike"]').waitFor({ timeout: 5000 }).catch(() => {});
      
      return { ok: true };
    } catch (error) {
      if (retry < 2) {
        await logMessage(`Like attempt ${retry + 1} failed (detached element?), retrying...`, config.LOG_FILE);
        await sleep(randomBetween(500, 1000));
        continue;
      }
      throw error;
    }
  }
  
  return { ok: false, reason: 'click-failed' };
}

// Process a single profile/search URL
async function processUrl(page, url, processed) {
  await logMessage(`Processing URL: ${url}`, config.LOG_FILE);
  
  try {
    await robustGoto(page, url, processed);
    
    // Check for login page
    if (await isLoginPage(page)) {
      await logMessage('ERROR: Login required! Please run "npm run save-session" again.', config.LOG_FILE);
      return { success: false, liked: 0 };
    }
    
    // Check for rate limiting
    if (await isRateLimited(page)) {
      await logMessage('WARNING: Rate limit detected. Implementing backoff...', config.LOG_FILE);
      const backoffDelay = calculateBackoff(0);
      await logMessage(`Waiting ${Math.round(backoffDelay / 1000)}s before retry...`, config.LOG_FILE);
      await sleep(backoffDelay);
      
      // Retry once
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForSelector('main, [data-testid="primaryColumn"], article', { timeout: 60000 });
        const currentUrl = page.url();
        await logMessage(`Reload successful. Current URL: ${currentUrl}`, config.LOG_FILE);
      } catch (error) {
        await logMessage(`Reload failed: ${error.message}`, config.LOG_FILE);
      }
      
      if (await isRateLimited(page)) {
        await logMessage('Still rate limited. Skipping this URL.', config.LOG_FILE);
        return { success: false, liked: 0 };
      }
    }
    
    // Collect tweet URLs
    let tweetUrls = await collectTweetIds(page, config.MAX_SCAN);
    await logMessage(`Found ${tweetUrls.length} tweet URLs to process.`, config.LOG_FILE);
    
    let likedCount = 0;
    let processedUrls = new Set();
    
    // Process tweets in batches
    while (likedCount < config.TWEETS_TO_LIKE && processed.dayCount < config.DAILY_CAP && tweetUrls.length > 0) {
      // Filter out already processed tweets
      const remainingUrls = tweetUrls.filter(url => {
        const statusId = url.split('/status/')[1]?.split('?')[0];
        return !processed.liked[statusId] && !processedUrls.has(url);
      });
      
      if (remainingUrls.length === 0) {
        // Need more tweets, scroll and recollect
        await logMessage('No new tweets in current batch, scrolling to collect more...', config.LOG_FILE);
        const scrollAmount = randomBetween(500, 1000);
        await page.evaluate((amount) => {
          window.scrollBy(0, amount);
        }, scrollAmount);
        await sleep(randomBetween(1000, 2000));
        
        const newUrls = await collectTweetIds(page, config.MAX_SCAN);
        const newUniqueUrls = newUrls.filter(url => !processedUrls.has(url));
        tweetUrls = [...tweetUrls, ...newUniqueUrls];
        continue;
      }
      
      // Process tweets up to limit
      for (const statusUrl of remainingUrls) {
        // Check daily cap
        if (processed.dayCount >= config.DAILY_CAP) {
          await logMessage(`Daily cap (${config.DAILY_CAP}) reached. Stopping.`, config.LOG_FILE);
          break;
        }
        
        // Check per-profile limit
        if (likedCount >= config.TWEETS_TO_LIKE) {
          await logMessage(`Per-profile limit (${config.TWEETS_TO_LIKE}) reached for this URL.`, config.LOG_FILE);
          break;
        }
        
        // Extract tweet ID for tracking
        const statusId = statusUrl.split('/status/')[1]?.split('?')[0];
        
        // Skip if already processed
        if (statusId && processed.liked[statusId]) {
          await logMessage(`Skipping already-liked tweet: ${statusId}`, config.LOG_FILE);
          processedUrls.add(statusUrl);
          continue;
        }
        
        try {
          // Like the tweet
          const result = await likeTweetById(page, statusUrl);
          
          if (result.ok) {
            if (result.already) {
              await logMessage(`Tweet already liked: ${statusUrl}`, config.LOG_FILE);
            } else {
              likedCount++;
              processed.dayCount++;
              
              await logMessage(
                `Liked tweet ${likedCount}/${config.TWEETS_TO_LIKE} (Daily: ${processed.dayCount}/${config.DAILY_CAP}) - ${statusUrl}`,
                config.LOG_FILE
              );
            }
            
            // Mark as processed
            if (statusId) {
              processed.liked[statusId] = true;
            }
            processedUrls.add(statusUrl);
            
            // Save processed state after each like
            await saveProcessed(processed);
            
            // Random delay between likes
            const delay = await randomDelay(config.DELAY_MIN_MS, config.DELAY_MAX_MS);
            await logMessage(`Waited ${Math.round(delay)}ms before next like.`, config.LOG_FILE);
            
            // Check for rate limiting after like
            if (await isRateLimited(page)) {
              const backoffDelay = calculateBackoff(0);
              await logMessage(`Rate limit detected. Backing off for ${Math.round(backoffDelay / 1000)}s...`, config.LOG_FILE);
              await sleep(backoffDelay);
            }
          } else {
            await logMessage(`Failed to like tweet ${statusUrl}: ${result.reason}`, config.LOG_FILE);
            processedUrls.add(statusUrl);
          }
        } catch (error) {
          await logMessage(`Error liking tweet ${statusUrl}: ${error.message}`, config.LOG_FILE);
          processedUrls.add(statusUrl);
        }
      }
      
      // Check if we've processed all available tweets and need more
      if (likedCount < config.TWEETS_TO_LIKE && processed.dayCount < config.DAILY_CAP) {
        const unprocessedCount = tweetUrls.filter(url => !processedUrls.has(url)).length;
        if (unprocessedCount === 0) {
          await logMessage('All collected tweets processed. Need to scroll for more...', config.LOG_FILE);
          const scrollAmount = randomBetween(500, 1000);
          await page.evaluate((amount) => {
            window.scrollBy(0, amount);
          }, scrollAmount);
          await sleep(randomBetween(1000, 2000));
          
          const newUrls = await collectTweetIds(page, config.MAX_SCAN);
          const newUniqueUrls = newUrls.filter(url => !processedUrls.has(url));
          tweetUrls = [...tweetUrls, ...newUniqueUrls];
        }
      }
    }
    
    await logMessage(`Completed URL. Liked ${likedCount} tweets.`, config.LOG_FILE);
    return { success: true, liked: likedCount };
    
  } catch (error) {
    await logMessage(`Error processing URL ${url}: ${error.message}`, config.LOG_FILE);
    return { success: false, liked: 0 };
  }
}

// Main function
async function main() {
  await logMessage('=== X/Twitter Like Bot Started ===', config.LOG_FILE);
  await logMessage(`Configuration: TWEETS_TO_LIKE=${config.TWEETS_TO_LIKE}, ROWS_PER_LAUNCH=${config.ROWS_PER_LAUNCH}, MAX_SCAN=${config.MAX_SCAN}, DAILY_CAP=${config.DAILY_CAP}`, config.LOG_FILE);
  
  // Check for storage state
  const statePath = path.resolve(config.STORAGE_STATE);
  if (await fs.pathExists(statePath)) {
    await logMessage(`Using storageState: ${statePath}`, config.LOG_FILE);
  } else {
    await logMessage(`ERROR: storageState file not found at: ${statePath}`, config.LOG_FILE);
    await logMessage(`Please run "npm run save-session" first to authenticate.`, config.LOG_FILE);
    process.exit(1);
  }
  
  // Load processed state
  const processed = await loadProcessed();
  await logMessage(`Loaded processed state: ${Object.keys(processed.liked).length} previously liked tweets, ${processed.dayCount} likes today.`, config.LOG_FILE);
  
  // Read CSV
  let urls = [];
  try {
    const csvContent = await fs.readFile(config.INPUT_FILE, 'utf8');
    const records = parse(csvContent, {
      columns: false,
      skip_empty_lines: true,
      trim: true,
    });
    
    urls = records.map(row => row[0]).filter(url => url && url.trim());
  } catch (error) {
    await logMessage(`ERROR: Could not read input file ${config.INPUT_FILE}: ${error.message}`, config.LOG_FILE);
    process.exit(1);
  }
  
  if (urls.length === 0) {
    await logMessage('ERROR: No URLs found in input file.', config.LOG_FILE);
    process.exit(1);
  }
  
  // Limit URLs per launch
  const urlsToProcess = urls.slice(0, config.ROWS_PER_LAUNCH);
  await logMessage(`Processing ${urlsToProcess.length} URL(s) (${urls.length} total in file).`, config.LOG_FILE);
  
  // Launch browser
  const browserOptions = {
    headless: config.HEADLESS,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  };
  
  let browser, context, page;
  
  try {
    browser = await chromium.launch(browserOptions);
    
    const contextOptions = {
      storageState: statePath,
      userAgent: config.USER_AGENT,
    };
    
    if (config.PROXY_URL) {
      contextOptions.proxy = { server: config.PROXY_URL };
    }
    
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
    
    // Process each URL
    for (let i = 0; i < urlsToProcess.length; i++) {
      const url = urlsToProcess[i];
      await logMessage(`\n--- Processing URL ${i + 1}/${urlsToProcess.length} ---`, config.LOG_FILE);
      
      const result = await processUrl(page, url, processed);
      
      // Pause between profiles (except for last one)
      if (i < urlsToProcess.length - 1) {
        const pause = randomBetween(2000, 5000);
        await logMessage(`Pausing ${Math.round(pause / 1000)}s before next profile...`, config.LOG_FILE);
        await sleep(pause);
      }
      
      // Check daily cap after each URL
      if (processed.dayCount >= config.DAILY_CAP) {
        await logMessage(`Daily cap reached. Stopping further processing.`, config.LOG_FILE);
        break;
      }
    }
    
  } catch (error) {
    await logMessage(`Fatal error: ${error.message}`, config.LOG_FILE);
    console.error(error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  
  await logMessage('\n=== Bot Finished ===', config.LOG_FILE);
  await logMessage(`Final stats: ${processed.dayCount} likes today, ${Object.keys(processed.liked).length} total liked tweets.`, config.LOG_FILE);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

