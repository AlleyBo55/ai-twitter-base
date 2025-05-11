import { openai } from '@ai-sdk/openai';

/**
 * Create the OpenAI embedding model instance
 */
const embeddingModel = openai.embedding('text-embedding-ada-002');

/**
 * Get a single embedding vector for the given text.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const result = await embeddingModel.doEmbed({ values: [text] });
  return result.embeddings[0];
}

/**
 * Get multiple embedding vectors in batch.
 */
export async function getBatchEmbeddings(texts: string[]): Promise<number[][]> {
  const result = await embeddingModel.doEmbed({ values: texts });
  return result.embeddings;
}
