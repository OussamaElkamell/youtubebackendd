
const HttpProxyAgent = require('http-proxy-agent');
const HttpsProxyAgent = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { ProxyModel } = require('../models/proxy.model');

/**
 * Create a proxy agent for a given proxy
 * @param {Object|String} proxy Proxy object or ID
 */
async function createProxyAgent(proxy) {
  try {
    // If proxy is an ID, fetch it from the database
    if (typeof proxy === 'string') {
      proxy = await ProxyModel.findById(proxy);
      if (!proxy) {
        throw new Error('Proxy not found');
      }
    }
    
    // Check if proxy is active
    if (proxy.status !== 'active') {
      throw new Error(`Proxy is ${proxy.status}`);
    }
    
    // Build proxy URL
    let proxyUrl;
    if (proxy.protocol === 'socks5') {
      // SOCKS proxy has a different URL format
      proxyUrl = `socks5://${proxy.username && proxy.password ? 
        `${proxy.username}:${proxy.password}@` : ''}${proxy.host}:${proxy.port}`;
    } else {
      // HTTP/HTTPS proxy URL
      proxyUrl = `${proxy.protocol}://${proxy.username && proxy.password ? 
        `${proxy.username}:${proxy.password}@` : ''}${proxy.host}:${proxy.port}`;
    }
    
    // Create appropriate agent
    let agent;
    if (proxy.protocol === 'http') {
      agent = new HttpProxyAgent(proxyUrl);
    } else if (proxy.protocol === 'https') {
      agent = new HttpsProxyAgent(proxyUrl);
    } else if (proxy.protocol === 'socks5') {
      agent = new SocksProxyAgent(proxyUrl);
    } else {
      throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
    }
    
    return agent;
  } catch (error) {
    console.error('Error creating proxy agent:', error);
    return null;
  }
}

/**
 * Assign a random active proxy to an account
 * @param {String} userId User ID
 * @param {String} accountId YouTube account ID
 */
async function assignRandomProxy(userId, accountId) {
  try {
    // Get a random active proxy
    const proxies = await ProxyModel.find({
      user: userId,
      status: 'active'
    });
    
    if (proxies.length === 0) {
      return { success: false, message: 'No active proxies available' };
    }
    
    const randomProxy = proxies[Math.floor(Math.random() * proxies.length)];
    
    // Update account with new proxy
    const { YouTubeAccountModel } = require('../models/youtube-account.model');
    const account = await YouTubeAccountModel.findById(accountId);
    
    if (!account) {
      return { success: false, message: 'Account not found' };
    }
    
    account.proxy = randomProxy._id;
    await account.save();
    
    return { 
      success: true, 
      message: 'Proxy assigned successfully',
      proxy: randomProxy
    };
  } catch (error) {
    console.error('Error assigning random proxy:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  createProxyAgent,
  assignRandomProxy
};
