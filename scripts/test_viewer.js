const viewerService = require('../services/viewer.service');

async function testViewer() {
    console.log('🚀 Starting Viewer Service Test...');

    const videoId = 'dQw4w9WgXcQ'; // Rick Astley - Never Gonna Give You Up (classic test video)
    const proxy = null; // Set to a proxy object { host, port, username, password } if you want to test with proxy

    const config = {
        minWatchTime: 10000, // 10 seconds for testing
        maxWatchTime: 15000,
        headless: false // Set to false to see the browser in action
    };

    try {
        console.log(`📺 Testing view for video: ${videoId}`);
        const result = await viewerService.simulateView(videoId, proxy, config);

        if (result.success) {
            console.log('✅ Success!');
            console.log(`⏱️ Watch Time: ${Math.round(result.watchTime / 1000)}s`);
        } else {
            console.error('❌ Failed!');
            console.error(`📁 Error: ${result.error}`);
        }
    } catch (error) {
        console.error('💥 Fatal error during test:');
        console.error(error);
    } finally {
        process.exit(0);
    }
}

testViewer();
