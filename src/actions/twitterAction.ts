import { Browser, Page } from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { db } from '../lib/mongodb';
import puppeteer from 'puppeteer';
// Path to store cookies and logs
const COOKIES_PATH = path.join(process.cwd(), 'cookies.json');
const LOG_PATH = path.join(process.cwd(), 'bot.log');

// MongoDB collection
const TWEETS_COLLECTION = 'tweets';

let browser: Browser | null = null;
let page: Page | null = null;

// Custom logging function
async function logMessage(message: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  await fs.appendFile(LOG_PATH, formattedMessage, 'utf8').catch(err => {
    console.error(`❌ Failed to write to log file: ${err.message}`);
  });
  if (level === 'warn' || level === 'error') {
    console[level](formattedMessage.trim());
  }
}

// Sanitize and normalize tweet content
function sanitizeTweet(content: string): string {
  return content.replace(/^["']|["']$/g, '').trim().toLowerCase();
}

async function saveCookies(page: Page): Promise<void> {
  try {
    const cookies = await page.cookies();
    await fs.writeFile(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    await logMessage('Cookies saved', 'info');
  } catch (err) {
    await logMessage(`Save cookies error: ${err}`, 'error');
    throw new Error('Could not save cookies');
  }
}

async function loadCookies(page: Page): Promise<boolean> {
  try {
    const cookiesString = await fs.readFile(COOKIES_PATH, 'utf-8');
    const cookies = JSON.parse(cookiesString);
    await page.setCookie(...cookies);
    await logMessage('Cookies loaded', 'info');
    return true;
  } catch (err) {
    await logMessage(`No valid cookies: ${err}`, 'warn');
    return false;
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 20000 });
  const selector = 'a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"], button[aria-label="Post"], button:has-text("Post")';
  const isLoggedIn = await page.waitForSelector(selector, { timeout: 5000 }).then(() => true).catch(() => false);
  await logMessage(isLoggedIn ? 'Session active' : 'Session inactive', 'info');
  return isLoggedIn;
}

export async function initTwitterSession(): Promise<{ browser: Browser; page: Page }> {
  if (browser && page) {
    if (await isLoggedIn(page)) return { browser, page };
    await logMessage('Existing session invalid, reinitializing...', 'warn');
    await browser.close();
    browser = null;
    page = null;
  }

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--mute-audio',
        '--disable-web-security', // Mitigate potential anti-bot measures
        '--disable-features=IsolateOrigins,site-per-process', // Improve headless compatibility
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    });

    page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    );

    page.on('console', msg => {
      if (msg.type() === 'error') {
        logMessage(`Browser console error: ${msg.text()}`, 'error');
      }
    });

    // Clear cookies to avoid stale session issues
    await page.deleteCookie(...(await page.cookies()));
    await logMessage('Cleared cookies before login', 'info');

    const cookiesLoaded = await loadCookies(page);
    if (cookiesLoaded && (await isLoggedIn(page))) {
      return { browser, page };
    }

    await page.goto('https://x.com/login', { waitUntil: 'networkidle2', timeout: 30000 }); // Increased timeout

    const usernameSelectors = [
      'input[autocomplete="username"]',
      'input[name="text"]',
      'input[type="text"]',
      'input[placeholder*="Username"]',
      'input[placeholder*="Phone, email, or username"]',
      'input[data-testid="LoginForm_Username"]',
      'input[role="textbox"]',
    ];

    let usernameSelector = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const selector of usernameSelectors) {
        try {
          await page.waitForSelector(selector, { visible: true, timeout: 20000 }); // Increased timeout
          usernameSelector = selector;
          await logMessage(`Found username input selector: ${selector}`, 'info');
          break;
        } catch (err) {
          await logMessage(`Attempt ${attempt}: Username selector ${selector} not found`, 'warn');
        }
      }
      if (usernameSelector) break;
      await logMessage(`Retry ${attempt}/3 for username input...`, 'warn');
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!usernameSelector) {
      const html = await page.content();
      await fs.writeFile('login_page.html', html);
      await page.screenshot({ path: 'login_error.png' });
      await logMessage('Failed to find username input. Check login_page.html and login_error.png.', 'error');
      throw new Error('Failed to find username input field');
    }

    await page.type(usernameSelector, process.env.TWITTER_USERNAME || '', { delay: 50 });
    await page.keyboard.press('Enter');

    const nextButtonSelectors = [
      'button[data-testid="LoginForm_Login_Button"]',
      'button[role="button"]:has-text("Next")',
      'button:has-text("Next")',
      'button[data-testid="LoginForm_NextButton"]',
    ];

    let nextButtonSelector = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const selector of nextButtonSelectors) {
        try {
          await page.waitForSelector(selector, { visible: true, timeout: 10000 });
          nextButtonSelector = selector;
          await logMessage(`Found next button selector: ${selector}`, 'info');
          break;
        } catch (err) {
          await logMessage(`Attempt ${attempt}: Next button selector ${selector} not found`, 'warn');
        }
      }
      if (nextButtonSelector) break;
      await logMessage(`Retry ${attempt}/3 for next button...`, 'warn');
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (nextButtonSelector) {
      await page.click(nextButtonSelector);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      await logMessage('Next button not found, proceeding to password input', 'warn');
    }

    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input[data-testid="LoginForm_Password"]',
      'input[placeholder*="Password"]',
      'input[role="textbox"][type="password"]',
    ];

    let passwordSelector = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      for (const selector of passwordSelectors) {
        try {
          await page.waitForSelector(selector, { visible: true, timeout: 20000 });
          passwordSelector = selector;
          await logMessage(`Found password input selector: ${selector}`, 'info');
          break;
        } catch (err) {
          await logMessage(`Attempt ${attempt}: Password selector ${selector} not found`, 'warn');
        }
      }
      if (passwordSelector) break;
      await logMessage(`Retry ${attempt}/3 for password input...`, 'warn');
      await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!passwordSelector) {
      const html = await page.content();
      await fs.writeFile('login_page.html', html);
      await page.screenshot({ path: 'login_error.png' });
      await logMessage('Failed to find password input. Check login_page.html and login_error.png.', 'error');
      throw new Error('Failed to find password input field');
    }

    await page.type(passwordSelector, process.env.TWITTER_PASSWORD || '', { delay: 50 });
    await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    await saveCookies(page);
    await logMessage('Logged into X', 'info');
    return { browser, page };
  } catch (err) {
    await logMessage(`Session init error: ${err}`, 'error');
    if (browser) await browser.close();
    browser = null;
    page = null;
    throw err;
  }
}

export async function hasTweet(content: string): Promise<boolean> {
  try {
    const sanitizedContent = sanitizeTweet(content);
    await logMessage(`Checking for tweet: ${sanitizedContent}`, 'info');
    const exists = !!(await db.collection(TWEETS_COLLECTION).findOne({ text: sanitizedContent }));
    await logMessage(`Tweet exists: ${exists}`, 'info');
    return exists;
  } catch (err) {
    await logMessage(`MongoDB tweet check error: ${err}`, 'error');
    return false;
  }
}

export async function storeTweet(content: string): Promise<void> {
  try {
    const sanitizedContent = sanitizeTweet(content);
    await logMessage(`Storing tweet: ${sanitizedContent}`, 'info');
    await db.collection(TWEETS_COLLECTION).insertOne({ text: sanitizedContent, createdAt: new Date() });
    await logMessage('Tweet stored successfully', 'info');
  } catch (err) {
    await logMessage(`MongoDB store error: ${err}`, 'error');
    throw err;
  }
}

export async function postTweet(content: string): Promise<void> {
  const { page, browser }: { browser: Browser; page: Page } = await initTwitterSession();
  try {
    const sanitizedContent = sanitizeTweet(content);
    await logMessage(`Raw tweet content: ${content}`, 'info');
    await logMessage(`Sanitized tweet content: ${sanitizedContent}`, 'info');

    if (await hasTweet(sanitizedContent)) {
      await logMessage(`Tweet already posted: ${sanitizedContent}`, 'warn');
      return;
    }

    await page.goto('https://x.com/compose/post', { waitUntil: 'networkidle2', timeout: 20000 });

    const inputSelectors = [
      'div[data-testid="tweetTextarea_0"][role="textbox"]',
      'div[data-testid="tweetTextarea_0"]',
      'div[contenteditable="true"][data-testid="tweetTextarea"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][placeholder*="Post"]',
      'div[contenteditable="true"][placeholder*="What is happening"]',
      'textarea[placeholder*="Post"]',
      'textarea[placeholder*="What is happening"]',
    ];

    let inputSelector = '';
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      for (const selector of inputSelectors) {
        try {
          await page.waitForSelector(selector, { visible: true, timeout: 20000 });
          inputSelector = selector;
          await logMessage(`Found tweet input selector: ${selector}`, 'info');
          break;
        } catch (err) {
          await logMessage(`Attempt ${attempt}: Selector ${selector} not found, trying next...`, 'warn');
        }
      }
      if (inputSelector) break;
      await logMessage(`Retry ${attempt}/${maxRetries} for tweet input...`, 'warn');
      await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!inputSelector) {
      const html = await page.content();
      await fs.writeFile('tweet_page.html', html);
      await page.screenshot({ path: 'tweet_input_error.png' });
      await logMessage('Failed to find tweet input field. Check tweet_page.html and tweet_input_error.png.', 'error');
      throw new Error('Failed to find tweet input field');
    }

    await page.type(inputSelector, sanitizedContent, { delay: 50 });

    const buttonSelectors = [
      'button[data-testid="tweetButton"]',
      'button[data-testid="tweetButtonInline"]',
      'div[data-testid="tweetButton"]',
      'div[data-testid="tweetButtonInline"]',
      'button[aria-label="Post"]',
      'button[aria-label="Tweet"]',
      'div[role="button"][data-testid="tweetButton"]',
      'div[role="button"][data-testid="tweetButtonInline"]',
      'button:has-text("Post")',
      'button:has-text("Tweet")',
      'button[role="button"]:has(svg)',
    ];

    let buttonSelector = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      for (const selector of buttonSelectors) {
        try {
          await page.waitForSelector(selector, { visible: true, timeout: 20000 });
          buttonSelector = selector;
          await logMessage(`Found tweet button selector: ${selector}`, 'info');
          break;
        } catch (err) {
          await logMessage(`Attempt ${attempt}: Selector ${selector} not found, trying next...`, 'warn');
        }
      }
      if (buttonSelector) break;
      await logMessage(`Retry ${attempt}/${maxRetries} for tweet button...`, 'warn');
      await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!buttonSelector) {
      const html = await page.content();
      await fs.writeFile('tweet_page.html', html);
      await page.screenshot({ path: 'tweet_button_error.png' });
      await logMessage('Failed to find tweet button. Check tweet_page.html and tweet_button_error.png.', 'error');
      throw new Error('Failed to find tweet button');
    }

    await page.click(buttonSelector);
    await new Promise(resolve => setTimeout(resolve, 1500));

    await logMessage(`Tweet posted: ${sanitizedContent}`, 'info');
    await storeTweet(sanitizedContent);
  } catch (err) {
    await logMessage(`Tweet error: ${err}`, 'error');
    await page.screenshot({ path: 'tweet_error.png' });
    throw err;
  }
}