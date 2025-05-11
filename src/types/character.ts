export interface CharacterDefinition {
    name: string;
    modelClass: 'small' | 'medium' | 'large';
    modelProvider: 'openai' | 'anthropic' | 'groq' | string;
    bio: string[];
    lore: string[];
    knowledge: string[];
    messageExamples: ConversationExample[][];
    postExamples: string[];
    topics: string[];
    style: {
      all: string[];
      chat: string[];
      post: string[];
    };
    adjectives: string[];
    twitterSpaces?: {
      systemPrompt: string;
    };
  }
  
  export interface ConversationExample {
    user: string;
    content: {
      text: string;
    };
  }
  