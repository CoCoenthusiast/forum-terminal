const CONTROL_AND_BIDI =
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;

export function sanitizeText(
  value: string | null | undefined,
  maxLength = 40
): string {
  if (value === null || value === undefined) return '';
  const cleaned = value.replace(CONTROL_AND_BIDI, '');
  return Array.from(cleaned).slice(0, maxLength).join('');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHtml(
  value: string | null | undefined,
  maxLength = 40
): string {
  return escapeHtml(sanitizeText(value, maxLength));
}
