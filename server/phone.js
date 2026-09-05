/**
 * Normalize Iraqi mobile numbers to a stable unique key (10 digits, no country code).
 * Examples: 9647701234567 / 07701234567 / 7701234567 -> 7701234567
 */
function normalizePhone(value) {
  if (value == null || value === '') return '';
  let s = String(value).trim();
  // scientific notation from Excel (unlikely for mobiles, but safe)
  if (/e\+/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = String(Math.round(n));
  }
  s = s.replace(/[^\d]/g, '');
  if (s.startsWith('964')) s = s.slice(3);
  if (s.startsWith('0') && s.length === 11) s = s.slice(1);
  if (s.length > 10) s = s.slice(-10);
  return s;
}

function formatPhoneDisplay(normalized) {
  if (!normalized) return '';
  return normalized;
}

module.exports = { normalizePhone, formatPhoneDisplay };
