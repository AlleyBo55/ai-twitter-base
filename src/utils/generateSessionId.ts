import { createHash } from 'crypto';
import { db } from '../lib/mongodb';

const sessionCollection = db.collection<{
  userId: string;
  sessionId: string;
  deviceId: string;
  messages: any[];
  lastActive: Date;
  lastActiveFormatted: string;
}>('session_messages');

/**
 * Generate a sessionId using MD5 of timestamp and random entropy.
 */
function hashSessionSeed(): string {
  const seed = `${Date.now()}-${Math.random()}`;
  return createHash('md5').update(seed).digest('hex');
}

/**
 * Check MongoDB to ensure no duplicate sessionId exists.
 */
export async function generateUniqueSessionId(): Promise<string> {
  let sessionId = '';
  let exists = true;

  while (exists) {
    sessionId = hashSessionSeed();
    exists = await sessionCollection.findOne({ sessionId }) !== null;
  }

  return sessionId;
}
