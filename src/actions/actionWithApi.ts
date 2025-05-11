import fs from 'fs/promises';
import path from 'path';
import { Collection } from 'mongodb';
import { TwitterApi } from 'twitter-api-v2';
import { db } from '../lib/mongodb';
import { TwitterAuthHandler } from '../auth/twitterSession';

// Path to store logs
const LOG_PATH: string = path.join(process.cwd(), 'bot.log');

// MongoDB collection
const TWEETS_COLLECTION: string = 'tweets';

// MongoDB tweet document interface
interface MongoTweet {
  text: string;
  createdAt: string;
  [key: string]: any; // Allow additional fields
}

// Type the MongoDB collection
const tweetCollection: Collection<MongoTweet> = db.collection<MongoTweet>(TWEETS_COLLECTION);

// Log levels
type LogLevel = 'info' | 'warn' | 'error';

// Custom logging function
async function logMessage(message: string, level: LogLevel = 'info'): Promise<void> {
  const timestamp: string = new Date().toISOString();
  const formattedMessage: string = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  try {
    await fs.appendFile(LOG_PATH, formattedMessage, 'utf8');
  } catch (err: unknown) {
    console.error(`❌ Failed to write to log file: ${(err as Error).message}`);
  }
  if (level === 'warn' || level === 'error') {
    console[level](formattedMessage.trim());
  }
}

// Sanitize and normalize tweet content
function sanitizeTweet(content: string): string {
  return content.replace(/^["']|["']$/g, '').trim().toLowerCase();
}

export async function initTwitterSession(): Promise<TwitterApi> {
  const authHandler = new TwitterAuthHandler({ logMessage });
  const isConnected = await authHandler.verifySession();
  if (!isConnected) {
    const errorMessage = 'Failed to verify Twitter API session';
    await logMessage(errorMessage, 'error');
    throw new Error(errorMessage);
  }
  return authHandler.getClient();
}

export async function hasTweet(content: string): Promise<boolean> {
  try {
    const sanitizedContent = sanitizeTweet(content);
    await logMessage(`Checking for tweet: ${sanitizedContent}`, 'info');
    const exists = !!(await tweetCollection.findOne({ text: sanitizedContent }));
    await logMessage(`Tweet exists: ${exists}`, 'info');
    return exists;
  } catch (err: unknown) {
    await logMessage(`MongoDB tweet check error: ${(err as Error).message}`, 'error');
    return false;
  }
}

export async function storeTweet(content: string): Promise<void> {
  try {
    const sanitizedContent = sanitizeTweet(content);
    await logMessage(`Storing tweet: ${sanitizedContent}`, 'info');
    await tweetCollection.insertOne({ text: sanitizedContent, createdAt: new Date().toISOString() });
    await logMessage('Tweet stored successfully', 'info');
  } catch (err: unknown) {
    await logMessage(`MongoDB store error: ${(err as Error).message}`, 'error');
    throw new Error(`MongoDB store error: ${(err as Error).message}`);
  }
}

export async function postTweet(content: string): Promise<void> {
  const client: TwitterApi = await initTwitterSession();
  try {
    const sanitizedContent = sanitizeTweet(content);
    await logMessage(`Raw tweet content: ${content}`, 'info');
    await logMessage(`Sanitized tweet content: ${sanitizedContent}`, 'info');

    if (await hasTweet(sanitizedContent)) {
      await logMessage(`Tweet already posted: ${sanitizedContent}`, 'warn');
      return;
    }

    await client.v2.tweet(sanitizedContent);
    await logMessage(`Tweet posted: ${sanitizedContent}`, 'info');
    await storeTweet(sanitizedContent);
  } catch (err: unknown) {
    await logMessage(`Tweet error: ${(err as Error).message}`, 'error');
    throw new Error(`Tweet error: ${(err as Error).message}`);
  }
}