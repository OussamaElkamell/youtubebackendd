

const { createClient } = require('redis');
 let redisClient;
async function initRedis() {
   

  try {
    if (redisClient?.isOpen) return true;

    redisClient = createClient({
      url: process.env.REDIS_URL,
      socket: {
        tls: {},
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
module.exports = {

  initRedis,
  redisClient: () => redisClient,
  
};
