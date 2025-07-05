const { createClient } = require('redis');

// Configuration constants
const REDIS_CONFIG = {
 host:'redis',
  port: 6379,

};

// Redis client singleton
let redisClient;

/**
 * Initialize Redis connection with optimized settings
 */
async function initRedis() {
  try {
    if (redisClient?.isOpen) return true;

    redisClient = createClient({
      url: process.env.REDIS_URL,
      socket: {
        tls: process.env.NODE_ENV === 'production',
        reconnectStrategy: (retries) => Math.min(retries * 100, 5000)
      },
      commandsQueueMaxLength: 1000,
      disableClientInfo: true,
      disableOfflineQueue: true,
      legacyMode: false
    });

    redisClient.on('error', (err) => console.error('Redis Client Error:', err));
    await redisClient.connect();
    console.log('Redis client connected successfully');
    return true;
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    return false;
  }
}

/**
 * Reset Redis data
 */
async function resetRedis() {
  try {
    await redisClient.flushAll();
    console.log('Redis has been reset.');
  } catch (error) {
    console.error('Error resetting Redis:', error);
  }
}

/**
 * Get Redis client instance
 */
function getRedisClient() {
  return redisClient;
}

module.exports = {
  REDIS_CONFIG,
  initRedis,
  resetRedis,
  getRedisClient
};