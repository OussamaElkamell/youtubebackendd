import { redis } from '@/lib/redis';

export class CacheService {
  private keyPrefix: string;

  constructor(prefix: string = 'app') {
    this.keyPrefix = prefix;
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await redis.get(this.getKey(key));
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      const data = JSON.stringify(value);
      await redis.set(this.getKey(key), data, ttlSeconds);
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await redis.del(this.getKey(key));
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return await redis.exists(this.getKey(key));
    } catch (error) {
      console.error('Cache exists error:', error);
      return false;
    }
  }

  async clear(pattern?: string): Promise<void> {
    try {
      const searchPattern = pattern 
        ? `${this.keyPrefix}:${pattern}` 
        : `${this.keyPrefix}:*`;
      
      const keys = await redis.keys(searchPattern);
      
      for (const key of keys) {
        await redis.del(key);
      }
    } catch (error) {
      console.error('Cache clear error:', error);
    }
  }

  // User-specific cache methods
  async getUserData<T>(userId: string, dataKey: string): Promise<T | null> {
    return this.get(`user:${userId}:${dataKey}`);
  }

  async setUserData<T>(userId: string, dataKey: string, value: T, ttlSeconds?: number): Promise<void> {
    return this.set(`user:${userId}:${dataKey}`, value, ttlSeconds);
  }

  async deleteUserData(userId: string, dataKey?: string): Promise<void> {
    if (dataKey) {
      return this.delete(`user:${userId}:${dataKey}`);
    } else {
      return this.clear(`user:${userId}:*`);
    }
  }

  // Session cache methods
  async getSession(sessionId: string): Promise<any | null> {
    return this.get(`session:${sessionId}`);
  }

  async setSession(sessionId: string, sessionData: any, ttlSeconds: number = 3600): Promise<void> {
    return this.set(`session:${sessionId}`, sessionData, ttlSeconds);
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.delete(`session:${sessionId}`);
  }

  // API response cache methods
  async getCachedApiResponse<T>(endpoint: string, params?: Record<string, any>): Promise<T | null> {
    const cacheKey = `api:${endpoint}${params ? ':' + JSON.stringify(params) : ''}`;
    return this.get(cacheKey);
  }

  async setCachedApiResponse<T>(
    endpoint: string, 
    data: T, 
    params?: Record<string, any>, 
    ttlSeconds: number = 300
  ): Promise<void> {
    const cacheKey = `api:${endpoint}${params ? ':' + JSON.stringify(params) : ''}`;
    return this.set(cacheKey, data, ttlSeconds);
  }
}

// Create default cache service instance
export const cacheService = new CacheService();