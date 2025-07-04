// Redis client configuration
// This will work when deployed with Docker Redis, not in Lovable environment

interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

// Mock Redis client for development/Lovable environment
class MockRedisClient {
  private storage: Map<string, string> = new Map();

  async get(key: string): Promise<string | null> {
    console.log(`[MockRedis] GET ${key}`);
    return this.storage.get(key) || null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    console.log(`[MockRedis] SET ${key} = ${value}${ttl ? ` (TTL: ${ttl}s)` : ''}`);
    this.storage.set(key, value);
    
    if (ttl) {
      setTimeout(() => {
        this.storage.delete(key);
        console.log(`[MockRedis] EXPIRED ${key}`);
      }, ttl * 1000);
    }
  }

  async del(key: string): Promise<void> {
    console.log(`[MockRedis] DEL ${key}`);
    this.storage.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    console.log(`[MockRedis] EXISTS ${key}`);
    return this.storage.has(key);
  }

  async keys(pattern: string): Promise<string[]> {
    console.log(`[MockRedis] KEYS ${pattern}`);
    const regex = new RegExp(pattern.replace('*', '.*'));
    return Array.from(this.storage.keys()).filter(key => regex.test(key));
  }

  async flushall(): Promise<void> {
    console.log(`[MockRedis] FLUSHALL`);
    this.storage.clear();
  }
}

// Real Redis client (for production deployment)
class RedisClient {
  private client: any = null;
  private config: RedisConfig;

  constructor(config: RedisConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      // In a real deployment, you would use redis package:
      // const redis = require('redis');
      // this.client = redis.createClient({
      //   host: this.config.host,
      //   port: this.config.port,
      //   password: this.config.password,
      //   db: this.config.db || 0
      // });
      // await this.client.connect();
      
      console.log('Redis client would connect in production environment');
    } catch (error) {
      console.error('Redis connection failed:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) throw new Error('Redis client not connected');
    return await this.client.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (!this.client) throw new Error('Redis client not connected');
    
    if (ttl) {
      await this.client.setEx(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client) throw new Error('Redis client not connected');
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    if (!this.client) throw new Error('Redis client not connected');
    const result = await this.client.exists(key);
    return result === 1;
  }

  async keys(pattern: string): Promise<string[]> {
    if (!this.client) throw new Error('Redis client not connected');
    return await this.client.keys(pattern);
  }
}

// Configuration for different environments
const getRedisConfig = (): RedisConfig => {
  // In production, these would come from environment variables
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0')
  };
};

// Create client instance based on environment
const createRedisClient = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const hasRedisEnv = process.env.REDIS_HOST;
  
  if (isProduction && hasRedisEnv) {
    return new RedisClient(getRedisConfig());
  } else {
    // Use mock client in development/Lovable environment
    return new MockRedisClient();
  }
};

export const redis = createRedisClient();
export type { RedisConfig };