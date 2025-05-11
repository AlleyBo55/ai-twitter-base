import fs from 'fs/promises';
import path from 'path';
import { WithId, Collection, Document } from 'mongodb';
import { TwitterApi, TwitterV2IncludesHelper, TweetV2, Tweetv2SearchResult, TTweetv2Expansion, TTweetv2TweetField, TTweetv2UserField } from 'twitter-api-v2';
import { generateSelfTweet } from '../actions/generateSelfTweet';
import { hasTweet, storeTweet, postTweet } from '../actions/actionWithApi';
import { db } from '../lib/mongodb';
import { pineconeIndex } from '../lib/pinecone-client';
import { getEmbedding } from '../lib/openai-embedding';
import { formatDate } from '../helpers/dateFormatter';
import usernames from '../target/unamelist.json';
import { MemoryEntry } from '../types/memory';
import { TwitterAuthHandler } from '../auth/twitterSession';
import { config } from 'dotenv';

// Load environment variables
config();

// Constants
const LOG_PATH = path.join(process.cwd(), 'bot.log');
const TWEETS_COLLECTION = 'tweets';
const REPLIED_MENTIONS_COLLECTION = 'replied_mentions';
const CACHE_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const USER_CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const RANDOM_POST_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const RANDOM_POST_COUNT = 5;
const RANDOM_DELAY_MIN_MS = 10 * 1000; // 10 seconds
const RANDOM_DELAY_MAX_MS = 30 * 1000; // 30 seconds
const RATE_LIMIT_WAIT_MS = 15 * 60 * 1000; // 15 minutes

// Types
type LogLevel = 'info' | 'warn' | 'error';

// Interfaces
interface MongoTweet extends Document {
  text: string;
  createdAt: string;
  tweets?: TweetData[];
  cachedAt?: Date;
  cachedUntil?: Date;
}

interface RepliedMention extends Document {
  mentionId: string;
  mentionText: string;
  replyText: string;
  repliedAt: string;
  cachedAt: Date;
  cachedUntil: Date;
}

interface TweetData {
  username: string;
  text: string;
  cachedAt: Date;
  cachedUntil: Date;
}

interface CachedUser extends Document {
  id: string;
  username: string;
  cachedAt: Date;
}

// MongoDB collections
const tweetCollection: Collection<MongoTweet> = db.collection<MongoTweet>(TWEETS_COLLECTION);
const repliedMentionsCollection: Collection<RepliedMention> = db.collection<RepliedMention>(REPLIED_MENTIONS_COLLECTION);

/**
 * Logs a message to a file and console.
 * @param message - The message to log.
 * @param level - The log level ('info', 'warn', 'error').
 */
async function logMessage(message: string, level: LogLevel = 'info'): Promise<void> {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  try {
    await fs.appendFile(LOG_PATH, formattedMessage, 'utf8');
    console.log(formattedMessage.trim());
  } catch (err) {
    console.error(`❌ Failed to write to log file: ${(err as Error).message}`);
  }
}

/**
 * Sanitizes tweet content by removing quotes and converting to lowercase.
 * @param content - The tweet content to sanitize.
 * @returns The sanitized content.
 */
function sanitizeTweet(content: string): string {
  return content.replace(/^["']|["']$/g, '').trim().toLowerCase();
}

/**
 * Sanitizes a search query by removing non-alphanumeric characters.
 * @param query - The query to sanitize.
 * @returns The sanitized query.
 */
function sanitizeQuery(query: string): string {
  return query.replace(/[^a-zA-Z0-9\s]/g, '').trim();
}

/**
 * Generates a random integer between min and max (inclusive).
 * @param min - The minimum value.
 * @param max - The maximum value.
 * @returns A random integer.
 */
function getRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Verifies MongoDB connection.
 * @returns True if connected, false otherwise.
 */
async function verifyMongoDBConnection(): Promise<boolean> {
  try {
    await db.command({ ping: 1 });
    await logMessage('MongoDB connection verified', 'info');
    return true;
  } catch (err) {
    await logMessage(`MongoDB connection error: ${(err as Error).message}`, 'error');
    return false;
  }
}

/**
 * Verifies Twitter API client.
 * @param client - The Twitter API client.
 * @param botUsername - The bot's username.
 * @returns True if verified, false otherwise.
 */
async function verifyTwitterClient(client: TwitterApi, botUsername: string): Promise<boolean> {
  try {
    const user = await client.v2.userByUsername(botUsername);
    if (user.data?.id) {
      await logMessage(`Twitter API client verified for @${botUsername}`, 'info');
      return true;
    }
    await logMessage(`Twitter API client verification failed: User @${botUsername} not found`, 'error');
    return false;
  } catch (err) {
    await logMessage(`Twitter API client verification error: ${(err as Error).message}`, 'error');
    return false;
  }
}

/**
 * Fetches recent tweets from MongoDB.
 * @param limit - Number of tweets to fetch (default: 5).
 * @returns An array of tweet texts.
 */
async function getRecentTweets(limit = 5): Promise<string[]> {
  try {
    const tweets = await tweetCollection
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return tweets
      .filter((tweet): tweet is WithId<MongoTweet> & { text: string } => typeof tweet.text === 'string')
      .map(tweet => tweet.text);
  } catch (err) {
    await logMessage(`Error fetching recent tweets: ${(err as Error).message}`, 'error');
    return [];
  }
}

/**
 * Checks if a mention has already been replied to.
 * @param mentionId - The ID of the mention tweet.
 * @returns True if the mention has been replied to, false otherwise.
 */
async function hasRepliedToMention(mentionId: string): Promise<boolean> {
  try {
    const exists = await repliedMentionsCollection.findOne({ mentionId });
    return !!exists;
  } catch (err) {
    await logMessage(`Error checking replied mention ${mentionId}: ${(err as Error).message}`, 'error');
    return false;
  }
}

/**
 * Stores a replied mention in MongoDB.
 * @param mentionId - The ID of the mention tweet.
 * @param mentionText - The text of the mention tweet.
 * @param replyText - The text of the reply.
 */
async function storeRepliedMention(mentionId: string, mentionText: string, replyText: string): Promise<void> {
  try {
    const cachedAt = new Date();
    const cachedUntil = new Date(cachedAt.getTime() + CACHE_DURATION_MS);
    await repliedMentionsCollection.insertOne({
      mentionId,
      mentionText,
      replyText,
      repliedAt: cachedAt.toISOString(),
      cachedAt,
      cachedUntil,
    });
    await logMessage(`Stored replied mention ${mentionId}`, 'info');
  } catch (err) {
    await logMessage(`Error storing replied mention ${mentionId}: ${(err as Error).message}`, 'error');
  }
}

/**
 * Fetches a user ID by username, using cache if available.
 * @param client - The Twitter API client.
 * @param username - The Twitter username.
 * @returns The user ID or null if not found.
 */
async function getUserId(client: TwitterApi, username: string): Promise<string | null> {
  const cached = await db.collection<CachedUser>('users').findOne({
    username,
    cachedAt: { $gte: new Date(Date.now() - USER_CACHE_DURATION_MS) },
  });
  if (cached) {
    await logMessage(`Using cached user ID for @${username}`, 'info');
    return cached.id;
  }
  try {
    const user = await client.v2.userByUsername(username);
    if (!user.data?.id) {
      await logMessage(`User @${username} not found`, 'warn');
      return null;
    }
    await db.collection<CachedUser>('users').updateOne(
      { username },
      { $set: { id: user.data.id, username, cachedAt: new Date() } },
      { upsert: true }
    );
    return user.data.id;
  } catch (err) {
    await logMessage(`Error fetching user @${username}: ${(err as Error).message}`, 'error');
    return null;
  }
}

/**
 * Fetches the latest tweets for a user, using cache if valid.
 * @param client - The Twitter API client.
 * @param username - The Twitter username.
 * @returns An array of tweet data.
 */
async function fetchLatestTweets(client: TwitterApi, username: string): Promise<TweetData[]> {
  await logMessage(`Fetching tweets for @${username}`, 'info');
  const cached = await tweetCollection.findOne({
    username,
    cachedUntil: { $gte: new Date() },
  });
  if (cached?.tweets) {
    await logMessage(`Using cached tweets for @${username}`, 'info');
    return cached.tweets;
  }
  try {
    const userId = await getUserId(client, username);
    if (!userId) return [];
    const tweets = await client.v2.userTimeline(userId, {
      max_results: 3,
      'tweet.fields': ['created_at', 'text'], // Fixed: tweet.fields
    });
    const cachedAt = new Date();
    const cachedUntil = new Date(cachedAt.getTime() + CACHE_DURATION_MS);
    const result: TweetData[] = [];
    for await (const tweet of tweets) {
      result.push({ username, text: tweet.text, cachedAt, cachedUntil });
    }
    await tweetCollection.updateOne(
      { username },
      { $set: { tweets: result, cachedAt, cachedUntil } },
      { upsert: true }
    );
    await logMessage(`Stored tweets for @${username} with cachedUntil: ${cachedUntil.toISOString()}`, 'info');
    return result;
  } catch (err: any) {
    if (err.code === 429) {
      await logMessage(`Rate limit exceeded for @${username}, waiting 15 minutes`, 'warn');
      await wait(RATE_LIMIT_WAIT_MS);
    }
    await logMessage(`Fetch tweets @${username}: ${err.message} ${JSON.stringify(err)}`, 'error');
    return [];
  }
}

/**
 * Checks the latest mentions, queues them, and replies to new ones.
 * @param client - The Twitter API client.
 * @param botUsername - The bot's username.
 */
async function checkLatestMentions(client: TwitterApi, botUsername: string): Promise<void> {
  await logMessage(`Entering checkLatestMentions for @${botUsername}`, 'info');
  try {
    const searchParams = {
      max_results: 10,
      'tweet.fields': ['created_at', 'text', 'author_id', 'id'] as TTweetv2TweetField[], // Fixed: tweet.fields
      'user.fields': ['username'] as TTweetv2UserField[], // Fixed: user.fields
      expansions: ['author_id'] as TTweetv2Expansion[],
    };
    await logMessage(`Executing search query: to:${botUsername} -is:retweet`, 'info');
    const searchResult = await client.v2.search(`to:${botUsername} -is:retweet`, searchParams);
    const includesHelper = new TwitterV2IncludesHelper(searchResult);
    const mentionQueue: { tweet: TweetV2; user: { username: string } }[] = [];

    // Build queue of mentions
    for await (const tweet of searchResult) {
      const user = includesHelper.users?.find(u => u.id === tweet.author_id);
      if (!user) {
        await logMessage(`User not found for mention tweet ID ${tweet.id}`, 'warn');
        continue;
      }
      mentionQueue.push({ tweet, user });
      await logMessage(`Queued mention from @${user.username}: ${tweet.text.slice(0, 50)}...`, 'info');
    }

    await logMessage(`Queued ${mentionQueue.length} mentions for processing`, 'info');
    let processedCount = 0;

    // Process queue
    for (const { tweet, user } of mentionQueue) {
      if (processedCount >= 10) break;
      const mentionId = tweet.id;
      if (await hasRepliedToMention(mentionId)) {
        await logMessage(`Mention ${mentionId} by @${user.username} already replied`, 'info');
        continue;
      }

      const tweetData: TweetData = {
        username: user.username,
        text: tweet.text,
        cachedAt: new Date(),
        cachedUntil: new Date(Date.now() + CACHE_DURATION_MS),
      };
      const reply = await generateReplyForTweet(tweetData);
      await replyToTweet(client, tweetData, reply, mentionId);
      await storeRepliedMention(mentionId, tweet.text, reply);
      await wait(5000); // 5s delay between replies
      processedCount++;
    }
    await logMessage(`Processed ${processedCount} new mentions`, 'info');
  } catch (err: any) {
    if (err.code === 429) {
      await logMessage(`Rate limit exceeded in checkLatestMentions, waiting 15 minutes`, 'warn');
      await wait(RATE_LIMIT_WAIT_MS);
    }
    await logMessage(`Error checking mentions: ${err.message} ${JSON.stringify(err)}`, 'error');
  }
  await logMessage('Exiting checkLatestMentions', 'info');
}

/**
 * Generates a reply for a tweet in Mandalorian style.
 * @param tweet - The tweet data to reply to.
 * @returns The generated reply.
 */
async function generateReplyForTweet(tweet: TweetData): Promise<string> {
  await logMessage(`Generating reply for tweet by @${tweet.username}`, 'info');
  const recentTweets = await getRecentTweets();
  const excludeContent = recentTweets.join(' | ');
  await logMessage(`Using excludeContent: ${excludeContent}`, 'info');
  return await generateSelfTweet(excludeContent);
}

/**
 * Replies to a tweet if it hasn't been replied to already.
 * @param client - The Twitter API client.
 * @param tweet - The tweet data to reply to.
 * @param reply - The reply text.
 * @param mentionId - The ID of the mention tweet (optional, for mentions).
 */
async function replyToTweet(client: TwitterApi, tweet: TweetData, reply: string, mentionId?: string): Promise<void> {
  await logMessage(`Attempting to reply to @${tweet.username}`, 'info');
  const sanitizedReply = sanitizeTweet(reply);
  if (await hasTweet(sanitizedReply)) {
    await logMessage(`Reply already posted: ${sanitizedReply}`, 'warn');
    return;
  }
  try {
    const userId = await getUserId(client, tweet.username);
    if (!userId) {
      await logMessage(`User @${tweet.username} not found`, 'warn');
      return;
    }
    const userTweets = await client.v2.userTimeline(userId, {
      max_results: 10,
      'tweet.fields': ['text', 'id'], // Fixed: tweet.fields
    });
    let tweetId: string | null = mentionId || null;
    if (!tweetId) {
      for await (const t of userTweets) {
        if (sanitizeTweet(t.text) === sanitizeTweet(tweet.text)) {
          tweetId = t.id;
          break;
        }
      }
    }
    if (!tweetId) {
      await logMessage(`Tweet by @${tweet.username} not found for reply`, 'warn');
      return;
    }
    const response = await client.v2.reply(sanitizedReply, tweetId);
    await logMessage(`Replied to @${tweet.username} (tweet ID: ${tweetId}): ${sanitizedReply} (Response: ${JSON.stringify(response)})`, 'info');
    await storeTweet(sanitizedReply);
  } catch (err: any) {
    if (err.code === 429) {
      await logMessage(`Rate limit exceeded for reply to @${tweet.username}, waiting 15 minutes`, 'warn');
      await wait(RATE_LIMIT_WAIT_MS);
    }
    await logMessage(`Reply error @${tweet.username}: ${err.message} ${JSON.stringify(err)}`, 'error');
  }
}

/**
 * Posts a random tweet generated by generateSelfTweet, ensuring uniqueness.
 * @param username - The bot's username.
 * @returns The posted tweet text or null if failed or duplicate.
 */
async function postRandomTweet(username: string): Promise<string | null> {
  await logMessage(`Generating random tweet for @${username}`, 'info');
  const recentTweets = await getRecentTweets(50);
  const excludeContent = recentTweets.join(' | ');
  await logMessage(`Using excludeContent: ${excludeContent}`, 'info');
  const tweetText = await generateSelfTweet(excludeContent);
  const sanitizedTweet = sanitizeTweet(tweetText);

  if (await hasTweet(sanitizedTweet)) {
    await logMessage(`Random tweet already posted: ${sanitizedTweet}`, 'warn');
    return null;
  }

  try {
    const response = await postTweet(tweetText);
    await logMessage(`Posted random tweet: ${tweetText} (Response: ${JSON.stringify(response)})`, 'info');
    await storeTweet(sanitizedTweet);

    const cachedAt = new Date();
    const cachedUntil = new Date(cachedAt.getTime() + CACHE_DURATION_MS);
    const tweetData: TweetData = { username, text: tweetText, cachedAt, cachedUntil };
    const embedding = await getEmbedding(tweetText);
    const memory: MemoryEntry = {
      username,
      query: tweetText,
      summary: `Random tweet by @${username}`,
      response: JSON.stringify({ text: tweetText }),
      intent: 'statement',
      topic: 'random',
      date: cachedAt.toISOString().split('T')[0],
      createdAt: formatDate(cachedAt),
      cachedAt: cachedAt.toISOString(),
    };
    await pineconeIndex.upsert([{
      id: Buffer.from(tweetText).toString('base64'),
      values: embedding,
      metadata: memory,
    }]);
    await logMessage(`Stored random tweet in Pinecone with cachedUntil: ${cachedUntil.toISOString()}`, 'info');
    return tweetText;
  } catch (err: any) {
    if (err.code === 429) {
      await logMessage(`Rate limit exceeded for posting tweet, waiting 15 minutes`, 'warn');
      await wait(RATE_LIMIT_WAIT_MS);
    }
    await logMessage(`Error posting random tweet: ${err.message} ${JSON.stringify(err)}`, 'error');
    return null;
  }
}

/**
 * Posts 5 random tweets with random delays, ensuring each is unique.
 * @param username - The bot's username.
 */
async function postRandomTweets(username: string): Promise<void> {
  await logMessage('Starting random tweet posting', 'info');
  let successfulPosts = 0;
  for (let i = 0; i < RANDOM_POST_COUNT; i++) {
    const delay = getRandomInt(RANDOM_DELAY_MIN_MS, RANDOM_DELAY_MAX_MS);
    await logMessage(`Waiting ${delay / 1000} seconds before posting tweet ${i + 1}`, 'info');
    await wait(delay);
    const result = await postRandomTweet(username);
    if (result) successfulPosts++;
  }
  await logMessage(`Completed random tweet posting: ${successfulPosts}/${RANDOM_POST_COUNT} tweets posted`, 'info');
}

/**
 * Waits for a specified number of milliseconds.
 * @param ms - The number of milliseconds to wait.
 * @returns A promise that resolves after the delay.
 */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Starts an infinite loop to engage with tweets, mentions, and post random tweets.
 */
export async function startHumanLoop(): Promise<void> {
  const topics = ['technology', 'news', 'culture'] as const;
  const botUsername = process.env.TWITTER_USERNAME || 'Bot';
  await logMessage(`Starting bot with human-like behavior for @${botUsername}`, 'info');
  console.log(`Starting bot with human-like behavior for @${botUsername}`);

  let authHandler: TwitterAuthHandler;
  try {
    authHandler = new TwitterAuthHandler({ logMessage });
  } catch (err) {
    await logMessage(`Failed to initialize TwitterAuthHandler: ${(err as Error).message}`, 'error');
    return;
  }

  // Verify MongoDB connection
  const isMongoConnected = await verifyMongoDBConnection();
  if (!isMongoConnected) {
    await logMessage('Aborting startup due to MongoDB connection failure', 'error');
    return;
  }

  let lastRandomPostTime = 0;

  while (true) {
    try {
      await logMessage('Checking Twitter API session', 'info');
      const isConnected = await authHandler.verifySession();
      await logMessage(`Twitter API session status: ${isConnected ? 'Connected' : 'Disconnected'}`, 'info');

      if (!isConnected) {
        await logMessage('Failed to establish Twitter API session, retrying in 60 seconds', 'error');
        await wait(60000);
        continue;
      }

      const client = authHandler.getClient();
      await logMessage('Twitter API client initialized', 'info');

      // Verify Twitter client
      const isTwitterVerified = await verifyTwitterClient(client, botUsername);
      if (!isTwitterVerified) {
        await logMessage('Twitter API client verification failed, retrying in 60 seconds', 'error');
        await wait(60000);
        continue;
      }

      // Check if it's time to post random tweets (every 3 hours)
      const currentTime = Date.now();
      if (currentTime - lastRandomPostTime >= RANDOM_POST_INTERVAL_MS) {
        await logMessage('Triggering random tweet posting', 'info');
        await postRandomTweets(botUsername);
        lastRandomPostTime = currentTime;
      }

      await logMessage('Starting engageWithTweets', 'info');
      await engageWithTweets(client);
      await logMessage('Completed engageWithTweets', 'info');

    } catch (err) {
      await logMessage(`Unexpected error in main loop: ${(err as Error).message}`, 'error');
    }

    await logMessage('Waiting 15 minutes for next cycle', 'info');
    await wait(15 * 60 * 1000);
  }
}

/**
 * Engages with tweets by checking mentions and user tweets.
 * @param client - The Twitter API client.
 */
async function engageWithTweets(client: TwitterApi): Promise<void> {
  try {
    await logMessage('Entering engageWithTweets', 'info');

    // Check and reply to latest mentions
    await logMessage('Checking latest mentions', 'info');
    await checkLatestMentions(client, process.env.TWITTER_USERNAME || 'Bot');

    // Engage with user tweets
    await logMessage('Engaging with user tweets', 'info');
    for (const username of usernames as string[]) {
      await logMessage(`Processing user @${username}`, 'info');
      const tweets = await fetchLatestTweets(client, username);
      for (const tweet of tweets) {
        await logMessage(`Replying to tweet by @${username}: ${tweet.text.slice(0, 50)}...`, 'info');
        const reply = await generateReplyForTweet(tweet);
        await replyToTweet(client, tweet, reply);
        await wait(5000);
      }
      await wait(10000);
    }

    await logMessage('Exiting engageWithTweets', 'info');
  } catch (err) {
    await logMessage(`Error in engageWithTweets: ${(err as Error).message}`, 'error');
  }
}