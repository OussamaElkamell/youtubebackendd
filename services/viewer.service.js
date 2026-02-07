const puppeteer = require('puppeteer');
const { createProxyAgent } = require('./proxy.service');
const { getRandomUserAgent } = require('./youtube.service');

/**
 * Robustly extract YouTube Video ID from various URL formats or standalone ID
 * @param {string} input - The YouTube URL or ID
 * @returns {string|null} - The validated 11-character video ID
 */
function extractVideoId(input) {
    if (!input) return null;

    // If it's already a clean 11-char ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
        return input;
    }

    // Handles: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID, etc.
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^\"&?\/\s]{11})/;
    const match = input.match(regex);
    return match ? match[1] : null;
}

/**
 * Simulate a YouTube view using Puppeteer
 * @param {string} videoInput - The YouTube video ID or full URL
 * @param {Object} proxy - The proxy configuration object from Prisma
 * @param {Object} config - Configuration for the view (minWatchTime, maxWatchTime, autoLike)
 */
async function simulateView(videoInput, proxy, config = {}) {
    const videoId = extractVideoId(videoInput);

    if (!videoId) {
        console.error(`[ViewerService] Invalid video input: ${videoInput}`);
        return { success: false, error: 'Invalid YouTube Video ID or URL' };
    }

    const {
        minWatchTime = 60000, // Default 1 minute
        maxWatchTime = 300000, // Default 5 minutes
        headless = 'new',
        autoLike = false
    } = config;

    let browser;
    try {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-infobars',
            '--window-position=0,0',
            '--ignore-certifcate-errors',
            '--ignore-certifcate-errors-spki-list',
            '--disable-blink-features=AutomationControlled',
            `--user-agent=${getRandomUserAgent()}`
        ];

        if (proxy) {
            // Puppeteer handles internal proxy differently than undici/axios
            // We need to pass it to the launch args
            const proxyUrl = `${proxy.host}:${proxy.port}`;
            args.push(`--proxy-server=${proxy.protocol}://${proxyUrl}`);
        }

        browser = await puppeteer.launch({
            headless,
            args
        });

        const page = await browser.newPage();

        // Hide webdriver trace
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // Set authentication if proxy has credentials
        if (proxy && proxy.username && proxy.password) {
            await page.authenticate({
                username: proxy.username,
                password: proxy.password
            });
        }

        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        console.log(`[ViewerService] Navigating to ${videoUrl} with proxy ${proxy?.host || 'none'}`);

        await page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 90000 });

        // Handle potential cookie consent popups
        try {
            const consentButton = await page.$('button[aria-label*="Accept"], button[aria-label*="Agree"], button[aria-label*="Tout accepter"], button[aria-label*="Accepter tout"]');
            if (consentButton) {
                await consentButton.click();
                console.log('[ViewerService] Clicked consent button');
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) { }

        // Set volume and quality randomly (imitating human behavior)
        try {
            await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) {
                    video.volume = 0.5 + Math.random() * 0.5;
                    // Mute if random roll < 0.2 to avoid noise in some environments
                    if (Math.random() < 0.2) video.muted = true;
                }
            });
        } catch (e) { }

        // Attempt to click play button if not auto-started
        try {
            const playButton = await page.$('.ytp-large-play-button');
            if (playButton) {
                await playButton.click();
                console.log('[ViewerService] Clicked play button');
            }
        } catch (e) { }

        // Handle Auto-Like if enabled
        console.log(`[ViewerService] Auto-Like enabled: ${autoLike}`);
        if (autoLike) {
            try {
                // Wait a bit before liking to look natural
                await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));

                const selectors = [
                    'button[aria-label*="like this video"]',
                    'button[aria-label*="J\'aime cette vidéo"]',
                    'button[aria-label*="Like this video"]',
                    'like-button-view-model button',
                    'ytd-toggle-button-renderer #button',
                    '#segmented-like-button button'
                ];

                let likeButton = null;
                let matchedSelector = null;

                for (const selector of selectors) {
                    likeButton = await page.$(selector);
                    if (likeButton) {
                        matchedSelector = selector;
                        break;
                    }
                }

                if (likeButton) {
                    console.log(`[ViewerService] Found like button using selector: ${matchedSelector}`);
                    const isPressed = await page.evaluate(el => el.getAttribute('aria-pressed') === 'true', likeButton);
                    if (!isPressed) {
                        try {
                            // Scroll into view first
                            await page.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), likeButton);
                            await new Promise(r => setTimeout(r, 1500));

                            // Try normal click
                            await likeButton.click();
                        } catch (clickErr) {
                            console.log(`[ViewerService] Standard click failed for ${matchedSelector}, trying JS click`);
                            // Fallback to JS click if normal click is blocked/obscured
                            await page.evaluate(el => el.click(), likeButton);
                        }

                        console.log(`[ViewerService] Successfully simulated like click for video ${videoId}`);
                    } else {
                        console.log(`[ViewerService] Video ${videoId} is already liked in this session`);
                    }
                } else {
                    console.log(`[ViewerService] Could not find any like button selector for video ${videoId}`);
                }
            } catch (e) {
                console.error(`[ViewerService] Error during like simulation for ${videoId}:`, e.message);
            }
        }

        // Wait for random duration
        const watchTime = Math.floor(Math.random() * (maxWatchTime - minWatchTime + 1)) + minWatchTime;
        console.log(`[ViewerService] Watching for ${Math.round(watchTime / 1000)} seconds...`);

        // Enhanced Human Behavior Simulation
        const startTime = Date.now();
        while (Date.now() - startTime < watchTime) {
            // Wait for random interval
            const wait = Math.floor(Math.random() * 10000) + 5000;
            await new Promise(r => setTimeout(r, Math.min(wait, watchTime - (Date.now() - startTime))));

            if (Date.now() - startTime >= watchTime) break;

            // Random action
            const roll = Math.random();
            if (roll < 0.3) {
                // Scroll
                await page.evaluate(() => {
                    window.scrollBy(0, Math.floor(Math.random() * 300) - 150);
                });
            } else if (roll < 0.4) {
                // Hover over something
                const elements = await page.$$('a, button, .ytp-chrome-bottom');
                if (elements.length > 0) {
                    const el = elements[Math.floor(Math.random() * elements.length)];
                    try { await el.hover(); } catch (e) { }
                }
            } else if (roll < 0.45) {
                // Pause for a moment (simulating pausing watch)
                try {
                    await page.keyboard.press('k');
                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
                    await page.keyboard.press('k');
                } catch (e) { }
            }
        }

        console.log(`[ViewerService] Finished watching video ${videoId}`);
        return { success: true, watchTime };

    } catch (error) {
        console.error(`[ViewerService] Error simulating view for ${videoId}:`, error.message);
        return { success: false, error: error.message };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

module.exports = {
    simulateView
};
