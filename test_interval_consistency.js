function calculateIntervalMs(interval) {
    const unit = interval?.unit || 'minutes';
    let value = Number(interval?.value || 0);

    // Only randomize if value is not set (or is 0) and we have random bounds
    // This prevents double-randomization since handleIntervalSchedule already sets a random value in the DB
    const min = Number(interval?.min ?? interval?.minValue);
    const max = Number(interval?.max ?? interval?.maxValue);

    if (value <= 0 && interval?.isRandom && !isNaN(min) && !isNaN(max)) {
        value = Math.floor(Math.random() * (max - min + 1)) + min;
    } else if (value <= 0) {
        value = 1; // Default fallback
    }

    switch (unit) {
        case 'minutes': return value * 60 * 1000;
        case 'hours': return value * 60 * 60 * 1000;
        case 'days': return value * 24 * 60 * 60 * 1000;
        default: return value * 60 * 1000;
    }
}

// Test cases
const tests = [
    {
        name: "Random enabled with existing value (should NOT randomize)",
        interval: { value: 15, unit: 'minutes', isRandom: true, min: 10, max: 20 },
        expected: 15 * 60 * 1000
    },
    {
        name: "Random enabled with value 0 (SHOULD randomize)",
        interval: { value: 0, unit: 'minutes', isRandom: true, min: 10, max: 20 },
        validate: (res) => res >= 10 * 60 * 1000 && res <= 20 * 60 * 1000
    },
    {
        name: "Support minValue/maxValue aliases",
        interval: { value: 0, unit: 'minutes', isRandom: true, minValue: 10, maxValue: 20 },
        validate: (res) => res >= 10 * 60 * 1000 && res <= 20 * 60 * 1000
    },
    {
        name: "Regular interval (no randomization)",
        interval: { value: 30, unit: 'minutes', isRandom: false },
        expected: 30 * 60 * 1000
    },
    {
        name: "Fallback to 1 if no value",
        interval: { unit: 'minutes' },
        expected: 1 * 60 * 1000
    }
];

let failed = 0;
tests.forEach(test => {
    const result = calculateIntervalMs(test.interval);
    let passed = false;

    if (test.expected !== undefined) {
        passed = result === test.expected;
    } else if (test.validate) {
        passed = test.validate(result);
    }

    if (passed) {
        console.log(`✅ [PASS] ${test.name}`);
    } else {
        console.log(`❌ [FAIL] ${test.name} - Result: ${result}`);
        failed++;
    }
});

if (failed === 0) {
    console.log("\n✨ All tests passed!");
    process.exit(0);
} else {
    console.log(`\n💥 ${failed} tests failed.`);
    process.exit(1);
}
