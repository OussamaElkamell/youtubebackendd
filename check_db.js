const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const result = await prisma.$queryRaw`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'Proxy';
    `;
        console.log('Columns in Proxy table:', result);

        // Also check YouTubeAccount columns just in case
        const ytResult = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'YouTubeAccount';
    `;
        console.log('Columns in YouTubeAccount table:', ytResult);

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
