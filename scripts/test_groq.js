const Groq = require("groq-sdk");
require('dotenv').config();

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

async function testGroqGenerator() {
    console.log('🚀 Testing Groq Comment Generator...');

    const testTitles = [
        "10 Tips for Better Coding",
        "How to Make the Perfect Omelette",
        "Extreme Mountain Biking in Utah"
    ];

    for (const title of testTitles) {
        console.log(`\nVideo Title: "${title}"`);
        try {
            const prompt = `Write one short, enthusiastic YouTube-style comment for a video titled "${title}". Keep it friendly and engaging. Output only the comment text.`;

            const response = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "user", content: prompt }],
                max_tokens: 50,
                temperature: 0.9,
            });

            const comment = response.choices[0].message.content.trim();
            console.log(`Generated Comment: "${comment}"`);
        } catch (error) {
            console.error(`❌ Error for title "${title}":`, error.message);
        }
    }
}

if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_api_key_here') {
    console.error('❌ Error: GROQ_API_KEY is not set in .env file.');
    process.exit(1);
}

testGroqGenerator();
