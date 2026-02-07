/**
 * Account Rotation Service
 * Handles rotation between principal and secondary accounts during sleep cycles
 */

/**
 * Get a random subset of accounts
 * @param {Array} accounts - Array of account IDs
 * @param {Number} count - Number of accounts to select
 * @returns {Array} - Random subset of account IDs
 */
function getRandomSubset(accounts, count) {
  if (!accounts || accounts.length === 0) return [];
  if (count >= accounts.length) return [...accounts];

  const shuffled = [...accounts].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/**
 * Rotate accounts during sleep cycle
 * - If currently using principal: randomly select N principal accounts to replace with N secondary
 * - If currently using secondary: swap back with different random principal accounts
 * 
 * @param {Object} schedule - The schedule document
 * @returns {Object} - Rotation result with new selected accounts and rotation state
 */
async function rotateAccountsForSleepCycle(schedule) {
  const { accountCategories, rotationEnabled, currentlyActive, selectedAccounts } = schedule;

  if (!rotationEnabled) {
    console.log('[Account Rotation] Rotation not enabled');
    return null;
  }

  // Support both Prisma (principalAccounts/secondaryAccounts) and legacy (accountCategories)
  let principal = (schedule.principalAccounts || []).map(a => a.id || a);
  let secondary = (schedule.secondaryAccounts || []).map(a => a.id || a);

  // Fallback to accountCategories if principal/secondary relations are missing
  if (principal.length === 0 && secondary.length === 0 && accountCategories) {
    principal = (accountCategories.principal || []).map(a => a.id || a);
    secondary = (accountCategories.secondary || []).map(a => a.id || a);
  }

  if (principal.length === 0 || secondary.length === 0) {
    console.log('[Account Rotation] Missing principal or secondary accounts data');
    return null;
  }

  // Calculate rotation count (30% of principal accounts or all secondary, whichever is smaller)
  const rotationCount = Math.min(
    Math.ceil(principal.length * 0.3),
    secondary.length
  );

  console.log(`[Account Rotation] Current active: ${currentlyActive}, Rotation count: ${rotationCount}`);

  // Get current selected account IDs
  const currentSelectedIds = selectedAccounts.map(a => a.id || a);

  if (currentlyActive === 'principal') {
    // Switch TO secondary accounts
    // Select random principal accounts from currently selected ones
    const principalInSelected = currentSelectedIds.filter(id => principal.includes(id));
    const randomPrincipalIds = getRandomSubset(principalInSelected, rotationCount);

    // Select random secondary accounts
    const randomSecondaryIds = getRandomSubset(secondary, rotationCount);

    // Create new selected accounts list: remove rotated principal, add secondary
    const newSelectedAccounts = [
      ...currentSelectedIds.filter(id => !randomPrincipalIds.includes(id)),
      ...randomSecondaryIds
    ];

    console.log(`[Account Rotation] 🔄 Switching TO secondary:`);
    console.log(`  - Rotated out principal: ${randomPrincipalIds.length} accounts`);
    console.log(`  - Rotated in secondary: ${randomSecondaryIds.length} accounts`);

    return {
      newSelectedAccounts,
      rotatedPrincipalIds: randomPrincipalIds,
      rotatedSecondaryIds: randomSecondaryIds,
      newActiveCategory: 'secondary'
    };

  } else {
    // Switch BACK TO principal accounts (use different ones than last time)
    const previouslyRotatedSecondary = (schedule.rotatedSecondary || []).map(a => a.id || a);
    const previouslyRotatedPrincipal = (schedule.rotatedPrincipal || []).map(a => a.id || a);

    // Try to get different principal accounts than last rotation
    const availablePrincipal = principal.filter(id =>
      !previouslyRotatedPrincipal.includes(id) && !currentSelectedIds.includes(id)
    );

    // If not enough new ones, use any principal accounts
    const poolToUse = availablePrincipal.length >= previouslyRotatedSecondary.length
      ? availablePrincipal
      : principal.filter(id => !currentSelectedIds.includes(id));

    const newRandomPrincipalIds = getRandomSubset(
      poolToUse.length > 0 ? poolToUse : principal,
      previouslyRotatedSecondary.length || rotationCount
    );

    // Create new selected accounts list: remove secondary, add new principal
    const newSelectedAccounts = [
      ...currentSelectedIds.filter(id => !previouslyRotatedSecondary.includes(id)),
      ...newRandomPrincipalIds
    ];

    console.log(`[Account Rotation] 🔄 Switching BACK TO principal:`);
    console.log(`  - Rotated out secondary: ${previouslyRotatedSecondary.length} accounts`);
    console.log(`  - Rotated in principal: ${newRandomPrincipalIds.length} accounts`);

    return {
      newSelectedAccounts,
      rotatedPrincipalIds: newRandomPrincipalIds,
      rotatedSecondaryIds: [],
      newActiveCategory: 'principal'
    };
  }
}

/**
 * Validate account rotation configuration
 * @param {Object} accountCategories - Principal and secondary account categories
 * @param {Boolean} enabled - Whether rotation is enabled
 * @returns {Object} - Validation result with isValid and error message
 */
function validateRotationConfig(accountCategories, enabled, schedule = {}) {
  if (!enabled) {
    return { isValid: true };
  }

  // Support both Prisma and legacy
  let principal = (schedule.principalAccounts || []).map(a => a.id || a);
  let secondary = (schedule.secondaryAccounts || []).map(a => a.id || a);

  if (principal.length === 0 && secondary.length === 0 && accountCategories) {
    principal = (accountCategories.principal || []).map(a => a.id || a);
    secondary = (accountCategories.secondary || []).map(a => a.id || a);
  }

  if (principal.length === 0) {
    return {
      isValid: false,
      error: 'At least one principal account is required when rotation is enabled'
    };
  }

  if (secondary.length === 0) {
    return {
      isValid: false,
      error: 'At least one secondary account is required when rotation is enabled'
    };
  }

  // Require at least 30% of principal count as secondary accounts
  const minSecondaryCount = Math.ceil(principal.length * 0.3);
  if (secondary.length < minSecondaryCount) {
    return {
      isValid: false,
      error: `You need at least ${minSecondaryCount} secondary accounts (30% of ${principal.length} principal accounts)`
    };
  }

  return { isValid: true };
}

module.exports = {
  rotateAccountsForSleepCycle,
  validateRotationConfig,
  getRandomSubset
};
