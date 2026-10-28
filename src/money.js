const MAX_AMOUNT = 1_000_000_000;

// Converts an API amount (number, max 2 decimals) to integer cents, or returns null if invalid.
function toCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  if (amount <= 0 || amount > MAX_AMOUNT) return null;
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) return null; // more than 2 decimal places
  return cents;
}

const fromCents = (cents) => cents / 100;

module.exports = { toCents, fromCents, MAX_AMOUNT };
