import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { buildSystemPrompt } from '../engine/characterEngine';
import characterDefinition from '../characters/mando.char.json';
import { CharacterDefinition } from '../types/character';

// Sanitize tweet content
function sanitizeTweet(content: string): string {
  return content.replace(/^["']|["']$/g, '').trim().toLowerCase();
}

// Runtime validation to ensure characterDefinition matches CharacterDefinition
function validateCharacterDefinition(data: any): data is CharacterDefinition {
  const validModelClasses = ['small', 'medium', 'large'];
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid character definition: Must be an object');
  }
  if (!validModelClasses.includes(data.modelClass)) {
    throw new Error(
      `Invalid modelClass: Must be one of ${validModelClasses.join(', ')}`,
    );
  }
  return true;
}

// Cast and validate the character definition
const validatedCharacterDefinition: CharacterDefinition = (() => {
  if (validateCharacterDefinition(characterDefinition)) {
    return characterDefinition as CharacterDefinition;
  }
  throw new Error('Failed to validate character definition');
})();

export async function generateSelfTweet(excludeContent?: string): Promise<string> {
  const basePrompt = buildSystemPrompt(validatedCharacterDefinition);
  const tweetInstructions = excludeContent
    ? `Generate a 1-sentence tweet as ${validatedCharacterDefinition.name}, reflecting your stoic, honorable Mandalorian style, exploring diverse themes (e.g., duty, loyalty, survival, adventure) and avoiding repetition of these tweets: "${excludeContent}". Do not include quotation marks. No hashtags.`
    : `Generate a 1-sentence tweet as ${validatedCharacterDefinition.name}, reflecting your stoic, honorable Mandalorian style, exploring diverse themes (e.g., duty, loyalty, survival, adventure). Do not include quotation marks. No hashtags.`;

  const systemPrompt = `${basePrompt} ${tweetInstructions}`;

  const result = await streamText({
    model: openai.chat('gpt-4'),
    temperature: 0.8, // Increase creativity
    topP: 0.9, // Encourage diverse outputs
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
    ],
  });

  let finalText = '';
  for await (const chunk of result.textStream as AsyncIterable<any>) {
    const text = typeof chunk === 'string' ? chunk : chunk?.text;
    if (text) finalText += text;
  }

  const sanitizedText = sanitizeTweet(finalText);
  console.log('📝 Raw tweet from AI:', finalText);
  console.log('📝 Sanitized tweet:', sanitizedText);
  return sanitizedText;
}