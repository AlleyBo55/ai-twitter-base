# 🧠 Sentient Twitter Bot Engine

This project is a modular AI agent framework designed to simulate human-like behavior on social media platforms, specifically Twitter. It leverages OpenAI's language model, Pinecone for vector-based memory recall, and MongoDB for session and memory storage. The bot can read trending topics, generate context-aware replies, and interact naturally using a defined character persona.

## 📁 Project Structure

```
src/
├── actions/                  # Self-action logic (e.g., generate tweet, interact)
├── auth/                     # Twitter API session handling
├── characters/               # Persona definitions (Eliza-style character files)
├── engine/                   # Core AI behavior and loop engine
├── lib/                      # Embedding, database, and Pinecone logic
├── server/                   # Express server entry point
├── target/                   # List of target usernames to monitor
├── types/                    # TypeScript definitions
├── utils/                    # Utility functions
```

## 🧠 Core Components

- **OpenAI GPT (via `lib/openai.ts`)**: Generates tweets and replies based on memory and character profile.
- **Pinecone (`lib/pinecone.ts`)**: Stores long-term memory using semantic vector similarity.
- **MongoDB (`lib/mongodb.ts`)**: Caches conversations and session context.
- **Character System**: Defined in `.char.json` files to simulate distinct personalities.
- **Behavior Engine**: Uses Puppeteer to observe or simulate user behavior on Twitter.
- **Human Loop**: Automatically initiates self-behavior logic when server starts.

## 🚀 Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/sentient-twitter-bot.git
cd sentient-twitter-bot
```

### 2. Install Dependencies

Ensure you have Node.js and `npm` installed:

```bash
npm install
```

### 3. Setup Environment

Create a `.env` file in the root with the following variables:

```env
OPENAI_API_KEY=your-openai-key
PINECONE_API_KEY=your-pinecone-key
PINECONE_ENVIRONMENT=your-pinecone-environment
MONGODB_URI=your-mongodb-uri
TWITTER_BEARER_TOKEN=your-twitter-bearer-token
TWITTER_APP_KEY=your-twitter-app-key
TWITTER_APP_SECRET=your-twitter-app-secret
TWITTER_ACCESS_TOKEN=your-access-token
TWITTER_ACCESS_SECRET=your-access-secret
```

### 4. Configure Target & Character

- Update `src/target/unamelist.json` with Twitter usernames to monitor.
- Modify or create new persona profiles in `src/characters/*.char.json`.

### 5. Start the Bot

```bash
npm run dev
```

This runs an Express server at `http://localhost:3000` and begins bot behavior automatically.

## 🛠 Development Notes

- Entry point: `src/server/index.ts`
- Behavior loop: `engine/behaviorWithApi.ts` or `behaviorWithPuppeteer.ts`
- All bot decisions are influenced by memory stored in MongoDB and Pinecone.
- Replies and generated content are tailored per character defined in `.char.json`.