import { getEmbedding } from '../lib/openai-embedding';
import { pineconeIndex } from '../lib/pinecone-client';
import { classifyContext } from '../utils/memory';

interface QueryOptions {
  intent?: string;
  type?: string;
  topic?: string;
  tone?: 'playful' | 'empathetic' | 'neutral' | 'serious'; // Added tone
}

export async function queryPineconeSimilarity(
  userId: string,
  query: string,
  threshold: number,
  detectIntent: (q: string) => string,
  saveToMongo: (userId: string, summary: string, query: string, response: any) => Promise<void>,
  checkMongoExists: (userId: string, query: string) => Promise<boolean>,
  options: QueryOptions = {}
): Promise<string | null> {
  const normalized = query.trim().toLowerCase();
  const embedding = await getEmbedding(normalized);

  const intent = options.intent ?? detectIntent(normalized);
  const { type, topic, tone } = {
    ...classifyContext(normalized), // Get type, topic, and tone from classifyContext
    ...options, // options override classification if provided
  };

  console.log(`🔍 Querying Pinecone for semantic + intent + topic + tone match (intent=${intent}, topic=${topic}, tone=${tone})...`);

  const results = await pineconeIndex.query({
    vector: embedding,
    topK: 5,
    includeMetadata: true,
    filter: {
      intent,
      topic,
      tone, // Include tone in filter
      ...(type && { type }), // Include type if provided
    },
  });

  const match = results.matches?.find(
    m =>
      (m.score as number) >= threshold &&
      m.metadata?.intent === intent &&
      m.metadata?.topic === topic &&
      m.metadata?.tone === tone && // Match on tone
      (!type || m.metadata?.type === type) // Match on type if provided
  );

  if (match?.metadata?.response) {
    const response = typeof match.metadata.response === 'string'
      ? match.metadata.response
      : JSON.stringify(match.metadata.response);

    const summary = typeof match.metadata.summary === 'string'
      ? match.metadata.summary
      : response;

    const exists = await checkMongoExists(userId, normalized);
    if (!exists) {
      console.log(`✅ Pinecone match (score ${(match.score as number).toFixed(2)}) — saving to Mongo`);
      await saveToMongo(userId, summary, normalized, response);
    } else {
      console.log('🗃️ Match already exists in Mongo');
    }

    return response;
  }

  console.log('❌ No matching result in Pinecone');
  return null;
}