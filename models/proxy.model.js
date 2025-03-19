
const mongoose = require('mongoose');

const ProxySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  host: {
    type: String,
    required: true
  },
  port: {
    type: Number,
    required: true
  },
  username: String,
  password: String,
  protocol: {
    type: String,
    enum: ['http', 'https', 'socks5'],
    default: 'http'
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'banned'],
    default: 'active'
  },
  location: String,
  lastChecked: Date,
  connectionSpeed: Number,
  notes: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Create formatted proxy URL
ProxySchema.virtual('url').get(function() {
  const auth = this.username && this.password 
    ? `${this.username}:${this.password}@` 
    : '';
  return `${this.protocol}://${auth}${this.host}:${this.port}`;
});

// Method to check proxy health
ProxySchema.statics.checkStatus = async function(proxyId) {
  try {
    const proxy = await this.findById(proxyId);
    if (!proxy) throw new Error('Proxy not found');
    
    const axios = require('axios');
    let agent;

    if (proxy.protocol === 'http') {
      const HttpProxyAgent = require('http-proxy-agent');
      agent = new HttpProxyAgent(proxy.url);
    } else if (proxy.protocol === 'https') {
      const HttpsProxyAgent = require('https-proxy-agent');
      agent = new HttpsProxyAgent(proxy.url);
    } else if (proxy.protocol === 'socks5') {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      agent = new SocksProxyAgent(proxy.url);
    }

    const startTime = Date.now();
    const response = await axios.get('https://www.google.com', {
      httpsAgent: agent,
      httpAgent: agent,
      timeout: 10000
    });
    const endTime = Date.now();

    // Update proxy status
    proxy.status = 'active';
    proxy.lastChecked = new Date();
    proxy.connectionSpeed = endTime - startTime;
    await proxy.save();
    
    return { success: true, speed: proxy.connectionSpeed };
  } catch (error) {
    if (proxy) {
      proxy.status = 'inactive';
      proxy.lastChecked = new Date();
      await proxy.save();
    }
    return { success: false, error: error.message };
  }
};

const ProxyModel = mongoose.model('Proxy', ProxySchema);

module.exports = { ProxyModel };
