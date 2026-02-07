const prisma = require('./prisma.service');
const axios = require('axios');

const getProxyUrl = (proxy) => {
    const auth = proxy.username && proxy.password
        ? `${proxy.username}:${proxy.password}@`
        : '';
    return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
};

const checkProxyStatus = async (proxyId) => {
    const proxy = await prisma.proxy.findUnique({
        where: { id: proxyId }
    });

    if (!proxy) throw new Error('Proxy not found');

    try {
        let agent;
        const url = getProxyUrl(proxy);

        if (proxy.protocol === 'http') {
            const { HttpProxyAgent } = require('http-proxy-agent');
            agent = new HttpProxyAgent(url);
        } else if (proxy.protocol === 'https') {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            agent = new HttpsProxyAgent(url);
        } else if (proxy.protocol === 'socks5') {
            const { SocksProxyAgent } = require('socks-proxy-agent');
            agent = new SocksProxyAgent(url);
        }

        const startTime = Date.now();
        await axios.get('https://www.google.com', {
            httpsAgent: agent,
            httpAgent: agent,
            timeout: 10000
        });
        const endTime = Date.now();

        const speed = endTime - startTime;

        const updatedProxy = await prisma.proxy.update({
            where: { id: proxyId },
            data: {
                status: 'active',
                lastChecked: new Date(),
                connectionSpeed: speed
            }
        });

        return { success: true, speed: updatedProxy.connectionSpeed };
    } catch (error) {
        await prisma.proxy.update({
            where: { id: proxyId },
            data: {
                status: 'inactive',
                lastChecked: new Date()
            }
        });
        return { success: false, error: error.message };
    }
};

module.exports = {
    checkProxyStatus,
    getProxyUrl
};
