 
// Round-robin account selector state
let lastUsedIndex = -1;

/**
 * Select accounts based on strategy
 */
function getAccountsByStrategy(schedule) {
  const activeAccounts = schedule.selectedAccounts.filter(a => a.status === 'active');
  if (activeAccounts.length === 0) return [];

  switch (schedule.accountSelection) {
    case 'specific': return activeAccounts;
    case 'random': return [activeAccounts[Math.floor(Math.random() * activeAccounts.length)]];
    case 'round-robin': 
      return activeAccounts.length > 0 ? [selectRoundRobinAccount(activeAccounts)] : [];
    default: return [];
  }
}

/**
 * Round-robin account selection
 */
function selectRoundRobinAccount(accounts) {
  if (!accounts || accounts.length === 0) return null;
  if (accounts.length === 1) {
    lastUsedIndex = 0;
    return accounts[0];
  }

  const nextIndex = (lastUsedIndex + 1) % accounts.length;
  lastUsedIndex = nextIndex;
  return accounts[nextIndex];
}

/**
 * Select next available account avoiding last used
 */
function selectNextAccount(accounts, lastUsedAccountId) {
  if (!accounts || accounts.length === 0) return null;

  const lastUsed = lastUsedAccountId?.toString() || null;
  console.log('lastUsed:', lastUsed);
  console.log("accounts:", accounts.map(a => a._id.toString()));

  // Find next account that wasn't the last used one
  let nextAccount = accounts.find(acc => acc._id.toString() !== lastUsed);
  
  // If all accounts were last used (single account case), use the first one
  if (!nextAccount) {
    nextAccount = accounts[0];
    console.log('Using first account as fallback');
  }

  console.log('Selected account:', nextAccount?._id.toString());
  return nextAccount;
}

module.exports = {
  getAccountsByStrategy,
  selectRoundRobinAccount,
  selectNextAccount
};
