import { Browser, Page } from 'puppeteer';
import { initTwitterSession } from '../auth/twitterSession';

export async function postTweet(content: string): Promise<void> {
  const { page }: { browser: Browser; page: Page } = await initTwitterSession();

  try {
    console.log('📝 Preparing to post tweet:', content);

    // Navigate to home page
    await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 30000 });

    // Debug: Take screenshot
    await page.screenshot({ path: 'tweet_page.png' });

    // Wait for the tweet input field
    const tweetInputSelector = 'div[role="textbox"][data-testid="tweetTextarea_0"]';
    await page.waitForSelector(tweetInputSelector, { visible: true, timeout: 30000 }).catch((err) => {
      console.error('❌ Tweet input not found:', err);
      throw new Error('Failed to find tweet input field.');
    });

    // Click and type the tweet
    console.log('Typing tweet content');
    await page.click(tweetInputSelector);
    await page.type(tweetInputSelector, content, { delay: 50 });

    // Wait for the tweet button
    const tweetButtonSelector = 'div[data-testid="tweetButton"]'; // Updated selector
    await page.waitForSelector(tweetButtonSelector, { visible: true, timeout: 30000 }).catch((err) => {
      console.error('❌ Tweet button not found:', err);
      throw new Error('Failed to find tweet button. Selector may be outdated.');
    });

    // Click the tweet button
    console.log('Clicking tweet button');
    await page.click(tweetButtonSelector);

    // Wait for the tweet to post (check for network idle or new tweet)
    await new Promise(resolve => setTimeout(resolve, 2000)); // Adjust based on network speed
    console.log('✅ Tweet posted successfully');

    // Debug: Take screenshot
    await page.screenshot({ path: 'post_tweet_page.png' });
  } catch (err) {
    console.error('💥 Error posting tweet:', err);
    await page.screenshot({ path: 'tweet_error.png' });
    throw err;
  }
}