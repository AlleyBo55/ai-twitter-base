import {
    getSessionMessages,
    updateSessionMessages,
    addOrUpdateLongTermMemory,
    searchValidCachedMemory,
    normalizeQuery,
    classifyContext
  } from '../utils/memory';
  import { queryPineconeSimilarity } from '../lib/pinecone';
  import { streamText } from 'ai';
  import { openai } from '@ai-sdk/openai';
  import { ToolSet } from 'ai';
  import type { CharacterDefinition } from '../types/character';
  import mandocharacter from '../characters/mando.char.json' assert { type: 'json' };
  import { buildSystemPrompt } from './characterEngine';
  
  export async function generateReply(username: string, input: string): Promise<string> {
    const normalized = normalizeQuery(input);
    const { intent, topic } = classifyContext(normalized);
  
    // 1️⃣ Check MongoDB (long-term memory exact match)
    const mongoHit = await searchValidCachedMemory(username, normalized);
    if (mongoHit?.response) {
      console.log('✅ Mongo exact match');
      return typeof mongoHit.response === 'string'
        ? mongoHit.response
        : JSON.stringify(mongoHit.response);
    }
  
    // 2️⃣ Check Pinecone (semantic match using intent + topic)
    const pineconeHit = await queryPineconeSimilarity(
      username,
      normalized,
      0.85,
      () => intent,
      addOrUpdateLongTermMemory,
      async (id, q) => !!(await searchValidCachedMemory(id, q)),
      { topic } // pass topic for more accurate filtering
    );
  
    if (pineconeHit) {
      console.log('✅ Pinecone semantic match');
      return typeof pineconeHit === 'string'
        ? pineconeHit
        : JSON.stringify(pineconeHit);
    }
  
    // 3️⃣ Fallback to OpenAI with short-term memory as context
    const context = await getSessionMessages(username);
    const systemPrompt = await buildSystemPrompt(mandocharacter as CharacterDefinition);
  
    const result = await streamText({
      model: openai.chat('gpt-4'),
      messages: [
        { role: 'system', content: systemPrompt },
        ...context,
        { role: 'user', content: input },
      ],
      tools: {} as ToolSet,
    });
  
    // 4️⃣ Read the stream and collect output
    let finalText = '';
    for await (const part of result.textStream as AsyncIterable<any>) {
      const text = typeof part === 'string' ? part : part?.text;
      if (text) finalText += text;
    }
  
    finalText = finalText.trim();
  
    // 5️⃣ Store result in memory
    if (finalText.length > 5) {
      await addOrUpdateLongTermMemory(username, finalText, normalized, finalText);
      await updateSessionMessages(username, [
        { role: 'user', content: input },
        { role: 'assistant', content: finalText },
      ]);
    } else {
      console.warn('⏭️ Skipping memory save: final reply too short');
    }
  
    return finalText;
  }
  