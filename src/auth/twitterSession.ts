import { TwitterApi } from 'twitter-api-v2';

// Interface for OAuth 1.0a credentials
interface TwitterCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

// Logger interface for dependency injection
interface Logger {
  logMessage: (message: string, level: 'info' | 'warn' | 'error') => Promise<void>;
}

// TwitterAuthHandler class
export class TwitterAuthHandler {
  private client: TwitterApi;
  private credentials: TwitterCredentials;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    // Load and validate credentials
    this.credentials = {
      appKey: process.env.TWITTER_API_KEY || '',
      appSecret: process.env.TWITTER_API_SECRET || '',
      accessToken: process.env.TWITTER_ACCESS_TOKEN || '',
      accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET || '',
    };

    if (!this.credentials.appKey || !this.credentials.appSecret) {
      throw new Error('Missing or invalid TWITTER_API_KEY or TWITTER_API_SECRET in .env');
    }
    if (!this.credentials.accessToken || !this.credentials.accessSecret) {
      throw new Error('Missing or invalid TWITTER_ACCESS_TOKEN or TWITTER_ACCESS_TOKEN_SECRET in .env');
    }

    this.client = new TwitterApi(this.credentials);
  }

  // Get the current client
  getClient(): TwitterApi {
    return this.client;
  }

  // Verify session or reconnect
  async verifySession(): Promise<boolean> {
    try {
      const user = await this.client.v2.me();
      await this.logger.logMessage(`Twitter API session verified for @${user.data.username}`, 'info');
      return true;
    } catch (err: unknown) {
      await this.logger.logMessage(`Session verification failed: ${(err as Error).message}`, 'warn');
      return await this.reconnect();
    }
  }

  // Reconnect on session expiration
  private async reconnect(): Promise<boolean> {
    try {
      this.client = new TwitterApi(this.credentials);
      const user = await this.client.v2.me();
      await this.logger.logMessage(`Reconnected to Twitter API as @${user.data.username}`, 'info');
      return true;
    } catch (err: unknown) {
      await this.logger.logMessage(`Reconnection failed: ${(err as Error).message}`, 'error');
      return false;
    }
  }
}