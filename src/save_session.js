require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');

const STORAGE_STATE = process.env.STORAGE_STATE || './state.json';

async function saveSession() {
  console.log('Launching browser...');
  console.log('Please log in to X/Twitter in the browser window that opens.');
  console.log('Once logged in, press ENTER in this terminal to save your session.');
  
  // Enhanced browser options with anti-detection
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  
  // Create context with realistic settings
  const context = await browser.newContext({
    userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: {
      width: 1920,
      height: 1080,
    },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    colorScheme: 'light',
  });
  
  const page = await context.newPage();
  
  // Inject stealth scripts to hide automation
  await page.addInitScript(() => {
    // Overwrite navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    
    // Mock chrome object
    window.chrome = {
      runtime: {},
    };
    
    // Mock permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
    
    // Overwrite plugins length
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    // Overwrite languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
  });
  
  try {
    // Navigate to login page instead of home (better for authentication flow)
    console.log('Navigating to X/Twitter login page...');
    await page.goto('https://x.com/i/flow/login', { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });
    
    // Wait a bit for the page to fully load
    await page.waitForTimeout(2000);
    
    // Check if we're already logged in (redirected to home)
    const currentUrl = page.url();
    if (currentUrl.includes('/home') || currentUrl === 'https://x.com/' || currentUrl === 'https://x.com/home') {
      console.log('Already logged in! You can press ENTER to save your session.');
    } else {
      console.log('Please complete the login process in the browser window...');
      console.log('If you encounter any errors, try refreshing the page or logging in manually.');
    }
  } catch (error) {
    console.error('Error navigating to X/Twitter:', error.message);
    console.log('You can manually navigate to https://x.com in the browser window.');
  }
  
  // Wait for user to press ENTER
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    rl.question('\nPress ENTER after you have logged in...\n', async () => {
      rl.close();
      
      try {
        // Save storage state
        const statePath = path.resolve(STORAGE_STATE);
        await fs.ensureDir(path.dirname(statePath));
        await context.storageState({ path: statePath });
        
        console.log(`\nSession saved successfully to: ${statePath}`);
        console.log('You can now use this session to run the bot.');
        
        await browser.close();
        resolve();
      } catch (error) {
        console.error('Error saving session:', error.message);
        await browser.close();
        process.exit(1);
      }
    });
  });
}

saveSession().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

