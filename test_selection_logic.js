
const recentAccountUsage = new Map();

function selectWeightedAccount(accounts, scheduleId, lastUsedAccountId) {
    if (!accounts || accounts.length === 0) return null;

    // Rule #1: NEVER use the same account twice in a row (if we have more than 1 account available)
    const available = accounts.length > 1
        ? accounts.filter(a => String(a.id) !== String(lastUsedAccountId))
        : accounts;

    if (available.length === 1) return available[0];

    const recentUse = recentAccountUsage.get(scheduleId) || new Map();

    // Rule #2: Prefer accounts that were used least recently (Weighted Selection)
    const weights = available.map(account => {
        const recentUseCount = recentUse.get(account.id.toString()) || 0;
        // Boost accounts that haven't been used yet or were used much less
        return Math.max(1, 20 - recentUseCount);
    });

    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let random = Math.random() * totalWeight;

    for (let i = 0; i < available.length; i++) {
        random -= weights[i];
        if (random <= 0) return available[i];
    }

    return available[0];
}

// Test
const accounts = [{ id: '1' }, { id: '2' }, { id: '3' }];
const scheduleId = 'test-sched';
let lastUsed = '1';

console.log('Testing 100 iterations...');
for (let i = 0; i < 100; i++) {
    const selected = selectWeightedAccount(accounts, scheduleId, lastUsed);
    if (String(selected.id) === String(lastUsed)) {
        console.error(`FAILURE: Selected ${selected.id} after ${lastUsed}`);
        process.exit(1);
    }
    // console.log(`Selected: ${selected.id} (Prev: ${lastUsed})`);
    lastUsed = selected.id;
}
console.log('SUCCESS: No consecutive duplicates found.');
