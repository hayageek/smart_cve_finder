/** Quotes, ampersands, and brackets usually mean gitleaks captured markup/config syntax, not a bare secret. */
const STRUCTURAL_CHARS = /[{}\[\]"'&]/;

/**
 * Reject secret values that contain JSON/HTML/config delimiters. Catches fragments like
 * `e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}` where the trailing `}` is not part of the token.
 */
export function isInvalidSecretShape(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  return STRUCTURAL_CHARS.test(v);
}
