const { createClient } = require('redis');

class CacheService {
  constructor(prefix = 'app') {
    this.keyPrefix = prefix;
    this.client = null;
    
    // Log Redis configuration (external Redis only, no Docker)
    console.log('📡 Redis configuration for external cache:', {
      url: process.env.REDIS_URL?.replace(/\/\/.*@/, '//***:***@'), // Hide credentials
      mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      tls: process.env.NODE_ENV === 'production'
    });
  }

  async initClient() {
  if (!this.client) {
    try {
      const redisURL = new URL(process.env.REDIS_URL);

      this.client = createClient({
        url: process.env.REDIS_URL,
        socket: {
          tls: redisURL.protocol === 'rediss:', // enable TLS only if using rediss
          connectTimeout: 10000,
          reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
        }
      });

      this.client.on('error', (err) =>
        console.error('❌ Cache Redis Client Error:', err)
      );

      this.client.on('connect', () =>
        console.log('✅ Connected to external Redis cache successfully')
      );

      await this.client.connect();
    } catch (err) {
      console.error('❌ Failed to initialize Redis cache client:', err);
    }
  }

  return this.client;
}

  getKey(key) {
    return `${this.keyPrefix}:${key}`;
  }

  async get(key) {
    try {
      const client = await this.initClient();
      const data = await client.get(this.getKey(key));
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  async set(key, value, ttlSeconds) {
    try {
      const client = await this.initClient();
      const data = JSON.stringify(value);
      if (ttlSeconds) {
        await client.set(this.getKey(key), data, { EX: ttlSeconds });
      } else {
        await client.set(this.getKey(key), data);
      }
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  async delete(key) {
    try {
      const client = await this.initClient();
      await client.del(this.getKey(key));
    } catch (error) {
      console.error('Cache delete error:', error);
    }
  }

  async exists(key) {
    try {
      const client = await this.initClient();
      return await client.exists(this.getKey(key));
    } catch (error) {
      console.error('Cache exists error:', error);
      return false;
    }
  }

  async clear(pattern) {
    try {
      const client = await this.initClient();
      const searchPattern = pattern 
        ? `${this.keyPrefix}:${pattern}` 
        : `${this.keyPrefix}:*`;
      
      const keys = await client.keys(searchPattern);
      
      for (const key of keys) {
        await client.del(key);
      }
    } catch (error) {
      console.error('Cache clear error:', error);
    }
  }

  // User-specific cache methods
  async getUserData(userId, dataKey) {
    return this.get(`user:${userId}:${dataKey}`);
  }

  async setUserData(userId, dataKey, value, ttlSeconds) {
    return this.set(`user:${userId}:${dataKey}`, value, ttlSeconds);
  }

  async deleteUserData(userId, dataKey) {
    if (dataKey) {
      return this.delete(`user:${userId}:${dataKey}`);
    } else {
      return this.clear(`user:${userId}:*`);
    }
  }

  // Session cache methods
  async getSession(sessionId) {
    return this.get(`session:${sessionId}`);
  }

  async setSession(sessionId, sessionData, ttlSeconds = 3600) {
    return this.set(`session:${sessionId}`, sessionData, ttlSeconds);
  }

  async deleteSession(sessionId) {
    return this.delete(`session:${sessionId}`);
  }

  // API response cache methods
  async getCachedApiResponse(endpoint, params) {
    const cacheKey = `api:${endpoint}${params ? ':' + JSON.stringify(params) : ''}`;
    return this.get(cacheKey);
  }

  async setCachedApiResponse(endpoint, data, params, ttlSeconds = 300) {
    const cacheKey = `api:${endpoint}${params ? ':' + JSON.stringify(params) : ''}`;
    return this.set(cacheKey, data, ttlSeconds);
  }
}

// Create default cache service instance
const cacheService = new CacheService();

module.exports = { CacheService, cacheService };