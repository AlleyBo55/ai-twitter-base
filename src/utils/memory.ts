import { db } from '../lib/mongodb';
import { pineconeIndex } from '../lib/pinecone-client';
import { getEmbedding } from '../lib/openai-embedding';
import { formatDate } from '../helpers/dateFormatter';
import type { MemoryEntry } from '../types/memory';

const longTermCollection = db.collection<MemoryEntry>('long_term_memory');
const sessionCollection = db.collection<{
  username: string;
  messages: any[];
  lastActive: Date;
  lastActiveFormatted: string;
}>('session_messages');

// Normalize input
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

// Intent & Topic classifier
export function classifyContext(query: string): {
  intent: 'question' | 'statement';
  topic: string;
  tone: 'playful' | 'empathetic' | 'neutral' | 'serious';
} {
  const q = query.toLowerCase();

  // Intent classification
  const intent = /(\?|what|why|how|who|when|is|are|do|does|should)/.test(q) ? 'question' : 'statement';

  // Topic classification
  const topic = /solana|eth|btc|pump\.fun|crypto/.test(q) ? 'crypto'
    : /star\s?wars|mandalorian|jedi|sith|grogu|beskar/.test(q) ? 'starwars'
    : /anime|manga|ghibli|otaku/.test(q) ? 'anime'
    : /music|song|album|track|playlist/.test(q) ? 'music'
    : /movie|film|director|cinema/.test(q) ? 'movie'
    : /actor|actress|celebrity|famous|idol/.test(q) ? 'celebrity'
    : /tech|software|engineer|developer|app/.test(q) ? 'tech'
    : /alien|conspiracy|galaxy|ufo/.test(q) ? 'alien'
    : /pop|trend|meme|viral|culture/.test(q) ? 'popculture'
    : 'other';

  // Tone classification
  const tone = /hug|love|care|whisper|sweet|friend|heart|smile|lol|haha|funny/.test(q) ? 'empathetic'
    : /joke|play|tease|fun|wink|lmao|rofl/.test(q) ? 'playful'
    : /war|battle|honor|duty|survive|fight|serious|code/.test(q) ? 'serious'
    : 'neutral';

  return { intent, topic, tone };
}

// Fetch short-term memory (conversation context)
export async function getSessionMessages(username: string): Promise<any[]> {
  const session = await sessionCollection.findOne({ username });
  return session?.messages || [];
}

// Update short-term memory with new messages
export async function updateSessionMessages(username: string, newMessages: any[]) {
  const now = new Date();
  const existing = await getSessionMessages(username);
  const updatedMessages = [...existing, ...newMessages];

  await sessionCollection.updateOne(
    { username },
    {
      $set: {
        messages: updatedMessages,
        lastActive: now,
        lastActiveFormatted: formatDate(now),
      },
    },
    { upsert: true }
  );
}

// Search long-term memory (exact MongoDB match)
export async function searchValidCachedMemory(username: string, query: string): Promise<MemoryEntry | null> {
  const normalized = normalizeQuery(query);
  console.log(`🧠 Checking Mongo for query: "${normalized}"`);

  try {
    const result = await longTermCollection.findOne({ query: normalized });
    if (!result) {
      console.log('❌ No Mongo match');
      return null;
    }

    console.log('✅ Found in Mongo');
    return result;
  } catch (err) {
    console.error('❌ Mongo error:', err);
    return null;
  }
}

// Upsert long-term memory to Mongo + Pinecone
export async function addOrUpdateLongTermMemory(
  username: string,
  summary: string,
  query: string,
  response: any
) {
  const now = new Date();
  const normalized = normalizeQuery(query);
  const { intent, topic, tone } = classifyContext(query); // Include tone
  const formatted = formatDate(now);

  await longTermCollection.updateOne(
    { query: normalized },
    {
      $set: {
        username,
        query: normalized,
        summary,
        response,
        intent,
        topic,
        tone, // Store tone in MongoDB
        date: now.toISOString().split('T')[0],
        createdAt: formatted,
        cachedAt: now.toISOString(),
      },
    },
    { upsert: true }
  );

  const embedding = await getEmbedding(normalized);

  const pineconeMatch = await pineconeIndex.query({
    vector: embedding,
    topK: 5,
    includeMetadata: true,
  });

  const matched = pineconeMatch.matches?.find(
    m =>
      (m.score ?? 0) >= 0.98 &&
      m.metadata?.intent === intent &&
      m.metadata?.topic === topic &&
      m.metadata?.tone === tone // Check tone
  );

  if (matched) {
    console.log(`⏭️ Skipped Pinecone upsert — matched (score: ${matched.score?.toFixed(2)})`);
    return;
  }

  await pineconeIndex.upsert([
    {
      id: Buffer.from(normalized).toString('base64'),
      values: embedding,
      metadata: {
        query: normalized,
        summary,
        response: typeof response === 'string' ? response : JSON.stringify(response),
        intent,
        topic,
        tone, // Store tone in Pinecone
      },
    },
  ]);

  console.log(`✅ Pinecone upserted with intent=${intent}, topic=${topic}, tone=${tone}`);
}