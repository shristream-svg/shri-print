// Pure HTML escaping: constructs numeric entities at runtime
// No literal entity strings to avoid source corruption

export function escapeHtml(text) {
  if (text == null) return '';
  return String(text).replace(/[&<>"']/g, ch => {
    const code = ch.charCodeAt(0);
    return '&#' + code + ';';
  });
}

export function escapeHtmlAttr(text) {
  if (text == null) return '';
  return String(text).replace(/[&<>"']/g, ch => {
    const code = ch.charCodeAt(0);
    return '&#' + code + ';';
  });
}
