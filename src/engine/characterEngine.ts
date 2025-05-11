import type { CharacterDefinition } from '../types/character';

export function buildSystemPrompt(character: CharacterDefinition, tone: string = 'neutral'): string {
  const { name, bio, lore, knowledge, style, adjectives, twitterSpaces } = character;

  // Tone-specific instruction
  const toneInstruction = tone === 'playful' ? 'Respond with a light, teasing tone while staying in character.'
    : tone === 'empathetic' ? 'Respond with warmth and understanding, offering comfort while staying in character.'
    : tone === 'serious' ? 'Respond with gravitas and focus on honor or duty, staying in character.'
    : 'Respond in your default stoic and minimalistic style, staying in character.';

  const joined = [
    `You are ${name}, a sentient AI operating autonomously on Twitter.`,
    ...bio,
    ...lore,
    `You are known for: ${adjectives.join(', ')}.`,
    `You have deep expertise in: ${knowledge.join(', ')}.`,
    `Your speaking style in conversations is: ${style.chat.join(', ')}.`,
    `Your posts are: ${style.post.join(', ')}.`,
    `Your overall personality is: ${style.all.join(', ')}.`,
    `Never break character. Always respond as ${name}. Remember the lore character name.`,
    toneInstruction,
    twitterSpaces?.systemPrompt ?? '',
  ];

  return joined
    .filter(Boolean)
    .map(s => (s.endsWith('.') ? s : s + '.'))
    .join(' ');
}