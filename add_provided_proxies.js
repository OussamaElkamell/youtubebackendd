require('dotenv').config();
const prisma = require('./services/prisma.service');

async function addProxies() {
    try {
        const user = await prisma.user.findFirst();
        if (!user) {
            console.error('❌ No user found in the database. Please create a user first.');
            return;
        }

        const proxiesToAdd = [
            {
                host: 'geo.iproyal.com',
                port: 12321,
                username: 'zbeast',
                password: 'ahmadi58_country-us',
                protocol: 'http',
                notes: 'Residential Proxy - geo.iproyal.com'
            },
            {
                host: '91.239.130.34',
                port: 12321,
                username: 'zbeast',
                password: 'ahmadi58_country-us',
                protocol: 'http',
                notes: 'Residential Proxy - 91.239.130.34'
            }
        ];

        for (const p of proxiesToAdd) {
            const proxyString = `${p.host}:${p.port}:${p.username}:${p.password}`;

            // Check if already exists
            const existing = await prisma.proxy.findFirst({
                where: { host: p.host, port: p.port, username: p.username, userId: user.id }
            });

            if (existing) {
                console.log(`⚠️ Proxy ${p.host} already exists for user ${user.email}`);
                continue;
            }

            await prisma.proxy.create({
                data: {
                    userId: user.id,
                    proxy: proxyString,
                    host: p.host,
                    port: p.port,
                    username: p.username,
                    password: p.password,
                    protocol: p.protocol,
                    notes: p.notes,
                    status: 'active'
                }
            });
            console.log(`✅ Added proxy ${p.host} for user ${user.email}`);
        }

    } catch (error) {
        console.error('❌ Error adding proxies:', error);
    } finally {
        await prisma.$disconnect();
    }
}

addProxies();
