const { ProxyAgent } = require('undici');
const prisma = require('./prisma.service');

/**
 * Create a proxy agent for a given proxy
 * @param {Object|String} proxy Proxy object or ID
 */
async function createProxyAgent(proxy) {
  try {
    if (typeof proxy === 'string') {
      proxy = await prisma.proxy.findUnique({
        where: { id: proxy }
      });
      if (!proxy) throw new Error('Proxy not found');
    }

    // ALLOW verifying inactive proxies to enable self-healing
    // if (proxy.status !== 'active') {
    //   throw new Error(`Proxy is ${proxy.status}`);
    // }

    // Ensure proxy credentials are correctly formatted
    const authPart = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
    const proxyUrl = `${proxy.protocol}://${authPart}${proxy.host}:${proxy.port}`;

    console.log("Proxy URL:", proxyUrl);

    // Create ProxyAgent using undici with authentication in the URL
    const agent = new ProxyAgent(proxyUrl);

    // Test the proxy by making a request
    const testUrl = 'https://ipv4.icanhazip.com';
    try {
      const response = await fetch(testUrl, {
        dispatcher: agent,
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`Proxy response (${response.status}) !== 200 when testing`);
      }

      const data = await response.text();
      console.log(`[ProxyService] Proxy IP (${proxy.host}):`, data.trim());

      // ✅ SELF-HEALING: If proxy was inactive, mark it as active
      if (proxy.status !== 'active') {
        console.log(`[ProxyService] 🩹 Proxy ${proxy.host} successfully self-healed! Reactivating...`);
        await prisma.proxy.update({
          where: { id: proxy.id },
          data: {
            status: 'active',
            notes: `${proxy.notes ? proxy.notes + ' | ' : ''}Reactivated by self-healing at ${new Date().toISOString()}`
          }
        });
      }

      return agent;
    } catch (testError) {
      console.error(`[ProxyService] Connectivity test failed for proxy ${proxy.host}:`, testError.message);

      // Update proxy status to inactive if it's a terminal error
      let statusNote = `Test failed: ${testError.message}`;
      if (testError.message.includes('402')) {
        statusNote = 'Proxy provider requires payment (402)';
      }

      // Only update if it's not already inactive or we want to log the latest failure
      await prisma.proxy.update({
        where: { id: proxy.id },
        data: {
          status: 'inactive',
          notes: `${statusNote} | Checked at ${new Date().toISOString()}`
        }
      });

      return null;
    }
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
    const proxies = await prisma.proxy.findMany({
      where: {
        userId: userId,
        status: 'active'
      }
    });

    if (proxies.length === 0) {
      return { success: false, message: 'No active proxies available' };
    }

    const randomProxy = proxies[Math.floor(Math.random() * proxies.length)];

    // Update account with new proxy
    const account = await prisma.youTubeAccount.findUnique({
      where: { id: accountId }
    });

    if (!account) {
      return { success: false, message: 'Account not found' };
    }

    await prisma.youTubeAccount.update({
      where: { id: accountId },
      data: {
        proxyId: randomProxy.id
      }
    });

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
