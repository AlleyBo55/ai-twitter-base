import { Browser, Page } from 'puppeteer';
import fs from 'fs/promises';
import { generateSelfTweet } from '../actions/generateSelfTweet';
import { postTweet, initTwitterSession, hasTweet, storeTweet } from '../actions/actionWithPuppeteer';
import { db } from '../lib/mongodb';
import { pineconeIndex } from '../lib/pinecone-client';
import { getEmbedding } from '../lib/openai-embedding';
import { formatDate } from '../helpers/dateFormatter';
import usernames from '../target/unamelist.json';
import path from 'path';
// Path to store logs
const LOG_PATH = path.join(process.cwd(), 'bot.log');

// MongoDB collection
const TWEETS_COLLECTION = 'tweets';

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

// Pinecone memory structure
interface MemoryEntry {
  username: string;
  query: string;
  summary: string;
  response: string;
  intent: 'summary';
  topic: string;
  date: string;
  createdAt: string;
  cachedAt: string;
  [key: string]: string | number | boolean;
}

// Sanitize tweet content
function sanitizeTweet(content: string): string {
  return content.replace(/^["']|["']$/g, '').trim().toLowerCase();
}

// Fetch recent tweets from MongoDB
async function getRecentTweets(limit: number = 5): Promise<string[]> {
  try {
    const tweets = await db.collection(TWEETS_COLLECTION)
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return tweets.map(tweet => tweet.text);
  } catch (err) {
    await logMessage(`Error fetching recent tweets: ${err}`, 'error');
    return [];
  }
}

// Fetch 3 latest tweets from a user
async function fetchLatestTweets(page: Page, username: string): Promise<{ username: string; text: string }[]> {
  try {
    await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 });
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
        .slice(0, 3)
        .map((el) => ({
          username: el.querySelector('a[href*="/"]')?.textContent?.replace('@', '') || 'unknown',
          text: el.textContent || '',
        }))
    );
  } catch (err) {
    await logMessage(`Fetch tweets @${username}: ${err}`, 'error');
    return [];
  }
}

// Generate reply for a tweet
async function generateReplyForTweet(tweet: { username: string; text: string }): Promise<string> {
  const recentTweets = await getRecentTweets();
  const excludeContent = recentTweets.join(' | ');
  const prompt = `Generate a 1-sentence reply to the tweet "${tweet.text}" from @${tweet.username}, addressing @${tweet.username} in a concise, engaging Mandalorian style. Avoid repeating themes from these tweets: "${excludeContent}". Do not include quotation marks. No hashtags.`;
  const reply = await generateSelfTweet(prompt);
  const sanitizedReply = sanitizeTweet(reply);
  await logMessage(`Raw reply: ${reply}`, 'info');
  await logMessage(`Sanitized reply: ${sanitizedReply}`, 'info');
  return sanitizedReply;
}

// Reply to a tweet
async function replyToTweet(page: Page, tweet: { username: string; text: string }, reply: string): Promise<void> {
  const sanitizedReply = sanitizeTweet(reply);
  if (await hasTweet(sanitizedReply)) {
    await logMessage(`Reply already posted: ${sanitizedReply}`, 'warn');
    return;
  }

  try {
    await page.goto(`https://x.com/${tweet.username}`, { waitUntil: 'networkidle2', timeout: 20000 });
    const article = (await page.$$('article[data-testid="tweet"]'))[0];
    if (!article) throw new Error('No tweets found');

    await article.click();
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
          await logMessage(`Found reply input selector: ${selector}`, 'info');
          break;
        } catch (err) {
          await logMessage(`Attempt ${attempt}: Selector ${selector} not found, trying next...`, 'warn');
        }
      }
      if (inputSelector) break;
      await logMessage(`Retry ${attempt}/${maxRetries} for reply input...`, 'warn');
      await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!inputSelector) {
      const html = await page.content();
      await fs.writeFile('reply_page.html', html);
      await page.screenshot({ path: 'reply_input_error.png' });
      await logMessage('Failed to find reply input field. Check reply_page.html and reply_input_error.png.', 'error');
      throw new Error('Failed to find reply input field');
    }

    await page.type(inputSelector, sanitizedReply, { delay: 50 });

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
      'button[role="button"]:has(svg)', // Fallback for SVG icon buttons
    ];

    let buttonSelector = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      for (const selector of buttonSelectors) {
        try {
          await page.waitForSelector(selector, { visible: true, timeout: 20000 });
          buttonSelector = selector;
          await logMessage(`Found reply button selector: ${selector}`, 'info');
          break;
        } catch (err) {
          await logMessage(`Attempt ${attempt}: Selector ${selector} not found, trying next...`, 'warn');
        }
      }
      if (buttonSelector) break;
      await logMessage(`Retry ${attempt}/${maxRetries} for reply button...`, 'warn');
      await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!buttonSelector) {
      const html = await page.content();
      await fs.writeFile('reply_page.html', html);
      await page.screenshot({ path: 'reply_button_error.png' });
      await logMessage('Failed to find reply button. Check reply_page.html and reply_button_error.png.', 'error');
      throw new Error('Failed to find reply button');
    }

    await page.click(buttonSelector);
    await new Promise(resolve => setTimeout(resolve, 1500));

    await logMessage(`Replied to @${tweet.username}: ${sanitizedReply}`, 'info');
    await storeTweet(sanitizedReply);
  } catch (err) {
    await logMessage(`Reply error @${tweet.username}: ${err}`, 'error');
    await page.screenshot({ path: 'reply_error.png' });
    throw err;
  }
}

// Scrape and store trending tweets
async function scrapeTrendingTweets(page: Page, topic: string): Promise<{ username: string; text: string } | null> {
  try {
    await page.goto(`https://x.com/search?q=${encodeURIComponent(topic)}&src=trend_click`, { waitUntil: 'networkidle2', timeout: 20000 });
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    const tweets = await page.evaluate(() =>
      Array.from(document.querySelectorAll('article[data-testid="tweet"]'))
        .slice(0, 50)
        .map((el) => ({
          username: el.querySelector('a[href*="/"]')?.textContent?.replace('@', '') || 'unknown',
          text: el.textContent || '',
        }))
    );

    const topTweet = tweets[0] || null;
    const now = new Date();
    for (const tweet of tweets) {
      const embedding = await getEmbedding(tweet.text);
      const memory: MemoryEntry = {
        username: tweet.username,
        query: tweet.text,
        summary: `Tweet by @${tweet.username} on "${topic}"`,
        response: JSON.stringify({ text: tweet.text }),
        intent: 'summary',
        topic,
        date: now.toISOString().split('T')[0],
        createdAt: formatDate(now),
        cachedAt: now.toISOString(),
      };

      await pineconeIndex.upsert([{
        id: Buffer.from(tweet.text).toString('base64'),
        values: embedding,
        metadata: memory,
      }]);
      await logMessage(`Stored tweet @${tweet.username} for ${topic}`, 'info');
    }

    return topTweet;
  } catch (err) {
    await logMessage(`Scrape error for "${topic}": ${err}`, 'error');
    return null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function startHumanLoop(): Promise<void> {
  let { browser, page }: { browser: Browser; page: Page } = await initTwitterSession();
  let lastTweetBatch = Date.now();
  let tweetsPosted = 0;

  try {
    async function maybeTweet() {
      const now = Date.now();
      if (now - lastTweetBatch >= 3 * 60 * 60 * 1000) {
        lastTweetBatch = now;
        tweetsPosted = 0;
      }

      if (tweetsPosted >= 5) return;

      const recentTweets = await getRecentTweets();
      const excludeContent = recentTweets.join(' | ');
      let tweet = await generateSelfTweet(excludeContent);
      let sanitizedTweet = sanitizeTweet(tweet);
      await logMessage(`Raw tweet: ${tweet}`, 'info');
      await logMessage(`Sanitized tweet: ${sanitizedTweet}`, 'info');

      let attempts = 0;
      const maxAttempts = 5;

      while (await hasTweet(sanitizedTweet) && attempts < maxAttempts) {
        await logMessage(`Duplicate tweet: "${sanitizedTweet}". Regenerating...`, 'warn');
        tweet = await generateSelfTweet(excludeContent);
        sanitizedTweet = sanitizeTweet(tweet);
        await logMessage(`Regenerated tweet: ${sanitizedTweet}`, 'info');
        attempts++;
      }

      if (attempts >= maxAttempts) {
        await logMessage('Max attempts reached. Skipping tweet.', 'warn');
        return;
      }

      await postTweet(sanitizedTweet);
      tweetsPosted++;
      await logMessage(`Tweeted: "${sanitizedTweet}" (${tweetsPosted}/5)`, 'info');
    }

    async function engageWithTweets() {
      await logMessage('Engaging with user tweets', 'info');
      for (const username of usernames) {
        const tweets = await fetchLatestTweets(page, username);
        for (const tweet of tweets) {
          const reply = await generateReplyForTweet(tweet);
          await replyToTweet(page, tweet, reply);
        }
      }

      await logMessage('Browsing trends', 'info');
      await page.goto('https://x.com/explore/tabs/for_you', { waitUntil: 'networkidle2', timeout: 20000 });
      const topics = await page.evaluate(() =>
        Array.from(document.querySelectorAll('div[data-testid="trend"]'))
          .map((el) => el.textContent?.trim() || '')
          .filter(Boolean)
          .slice(0, 3)
      );

      let topTweet: { username: string; text: string } | null = null;
      for (const topic of topics) {
        const tweet = await scrapeTrendingTweets(page, topic);
        if (!topTweet && tweet) topTweet = tweet;
      }

      if (topTweet) {
        await logMessage(`Replying to top trend tweet by @${topTweet.username}`, 'info');
        const reply = await generateReplyForTweet(topTweet);
        await replyToTweet(page, topTweet, reply);
      }
    }

    while (true) {
      const isActive = await page.evaluate(() =>
        !!document.querySelector('a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"], button[aria-label="Post"], button:has-text("Post")')
      );
      if (!isActive) {
        await logMessage('Session expired, reinitializing...', 'warn');
        await browser.close();
        ({ browser, page } = await initTwitterSession());
      }

      await maybeTweet();
      await engageWithTweets();
      await wait(120000);
    }
  } catch (err) {
    await logMessage(`Engagement loop error: ${err}`, 'error');
    await page.screenshot({ path: 'loop_error.png' });
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}