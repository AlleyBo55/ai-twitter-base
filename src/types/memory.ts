export interface MemoryEntry {
    username: string;
    query: string;
    summary: string;
    response: string;
    intent: "question" | "statement";
    topic: string;
    date: string;
    createdAt: string;
    cachedAt: string; // Required field
    [key: string]: string | number | boolean;
  }