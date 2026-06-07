/** Quotes, markup, and config delimiters — usually syntax around a token, not the secret itself. */
const STRUCTURAL_CHARS = /[{}\[\]"'&()<>,`%+|@:;?]/;

/** Same as STRUCTURAL_CHARS but allows `+` (valid inside 40-char AWS secret access keys). */
const STRUCTURAL_CHARS_STRICT = /[{}\[\]"'&()<>,`%|@:;?]/;

const PEM_PRIVATE_KEY = /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+|DSA\s+|PGP\s+)?PRIVATE KEY(?:\s+BLOCK)?-----/;

/** Base64 uses + and =; multi-segment paths with slashes usually do not. */
const BASE64_MARKERS = /[+=]/;

const BASE64_ALPHABET = /^[A-Za-z0-9+/=]+$/;

/** Prefixes for formats that may be long but are real credential shapes. */
const KNOWN_SECRET_PREFIX =
  /^(?:sk[-_]|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AKIA|ASIA|AGPA|AIDA|AROA|xox[baprs]-|AIza|SG\.|-----BEGIN|rk[-_]live_|pk[-_]live_|sk[-_]live_|eyJ|chpt_)/i;

/** Long base64-only blobs are usually embedded data, not API keys. */
const OPAQUE_BASE64_MIN_LEN = 80;

/** Min run length for obvious placeholder sequences (abcd, 1234). */
const SEQUENTIAL_PLACEHOLDER_MIN_LEN = 5;

/** Full base32 alphabet — common doc/example OTP secret (e.g. rclone protondrive). */
const BASE32_ALPHABET_PLACEHOLDER = /^ABCDEFGHIJKLMNOPQRSTUVWXYZ234567$/i;

/** 32-char lowercase hex — MD5 / content hashes (together-ai rule FP). */
const LOWERCASE_HEX_32 = /^[0-9a-f]{32}$/;

/** GUID / UUID literals in source (incl. malformed captures missing a leading hex digit). */
const HEX_GUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MALFORMED_HEX_GUID =
  /^[0-9a-fA-F]{7}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_WITH_TRAILING_JUNK =
  /^[0-9a-fA-F-]{6,36}[0-9a-fA-F][^0-9a-fA-F-]/;

/** PascalCase / camelCase type or member names (e.g. AzureChatPromptExecutionSettings). */
const CODE_IDENTIFIER_SUFFIX =
  /(?:Settings|Config|Options|Handler|Provider|Execution|Context|Request|Response|Definition|Properties|Exception|Arguments|Metadata|Prompt|KeyPrefix|Token)$/i;

function isRedactedPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v || v === 'REDACTED') return true;
  if (/^\*+$/.test(v)) return true;
  if (/\*{4,}/.test(v)) return true;
  return false;
}

function isAscendingOrDescendingRun(lower: string): boolean {
  const codes = [...lower].map((c) => c.charCodeAt(0));
  let ascending = true;
  let descending = true;
  for (let i = 1; i < codes.length; i++) {
    const diff = codes[i] - codes[i - 1];
    if (diff !== 1) ascending = false;
    if (diff !== -1) descending = false;
  }
  return ascending || descending;
}

/** Placeholder runs like `abcdef`, `12345`, or `fedcba` — not real secrets. */
function looksLikeSequentialPlaceholder(value: string): boolean {
  if (value.length < SEQUENTIAL_PLACEHOLDER_MIN_LEN) return false;

  const lower = value.toLowerCase();
  const allLetters = /^[a-z]+$/.test(lower);
  const allDigits = /^[0-9]+$/.test(lower);
  if (allLetters || allDigits) return isAscendingOrDescendingRun(lower);

  // e.g. ABCDEFGHIJKLMNOPQRSTUVWXYZ234567 — sequential letters then sequential digits
  const parts = value.match(/^([A-Za-z]{5,})([0-9]{5,})$/);
  if (parts) {
    return (
      isAscendingOrDescendingRun(parts[1].toLowerCase()) &&
      isAscendingOrDescendingRun(parts[2])
    );
  }

  return false;
}

function looksLikeBase32AlphabetPlaceholder(value: string): boolean {
  return BASE32_ALPHABET_PLACEHOLDER.test(value);
}

/** Obvious example/placeholder token (not a high-entropy credential). */
function looksLikePlaceholderToken(value: string): boolean {
  const t = value.trim();
  if (!t) return true;
  if (isRedactedPlaceholder(t)) return true;
  if (looksLikeBase32AlphabetPlaceholder(t)) return true;
  if (looksLikeSequentialPlaceholder(t)) return true;
  return false;
}

/** RHS of `key=value` / `-flag=value` captures (incl. spaced ` = `). */
function extractAssignmentRhs(value: string): string | undefined {
  const m = value.match(/^-?[A-Za-z][A-Za-z0-9_-]*\s*=\s*(.+)$/);
  return m?.[1]?.trim();
}

/**
 * Path/URL fragments (e.g. `src/config/prod.key`) but not PEM lines that happen to contain `/`.
 */
function looksLikePathFragment(value: string): boolean {
  if (value.includes('://')) return true;
  if (/^[a-zA-Z]:\\/.test(value)) return true;

  const slashes = (value.match(/\//g) ?? []).length;
  if (slashes >= 2 && !BASE64_MARKERS.test(value)) return true;

  const backslashes = (value.match(/\\/g) ?? []).length;
  if (backslashes >= 2 && !BASE64_MARKERS.test(value)) return true;

  return false;
}

/** Real API keys do not end with `/`; trailing slash is a base64-chunk fragment. PEM blocks are exempt above. */
function endsWithBase64Slash(value: string): boolean {
  return value.endsWith('/');
}

/** Captured closing syntax from JSON, YAML, OpenAPI, or shell (not part of the token). */
function hasTrailingCaptureJunk(value: string): boolean {
  return /[.%\\|:\-+;?]$/.test(value);
}

/** Leading `\` from PHP namespaces, escaped `\n`, or other source-capture bleed. */
function hasLeadingBackslashCaptureJunk(value: string): boolean {
  return /^\\/.test(value);
}

/** Leading `.Field` from Go AWS SDK captures (vault-service-token FP); not `SG.` tokens. */
function hasLeadingDotCaptureJunk(value: string): boolean {
  if (KNOWN_SECRET_PREFIX.test(value)) return false;
  return /^\.[A-Z]/.test(value);
}

/** AWS secret access keys are exactly 40 base64 characters and may contain `+` or `/`. */
function looksLikeAwsSecretAccessKey(value: string): boolean {
  return value.length === 40 && BASE64_ALPHABET.test(value);
}

/** Short dashed-hex fragments (partial UUIDs / OpenAPI example ids). */
function looksLikeDashedHexFragment(value: string): boolean {
  if (!/^[0-9a-fA-F-]+$/.test(value)) return false;
  if (KNOWN_SECRET_PREFIX.test(value)) return false;
  if (HEX_GUID.test(value) || MALFORMED_HEX_GUID.test(value)) return true;
  return value.includes('-') && value.length < 40;
}

function looksLikeHexGuid(value: string): boolean {
  return HEX_GUID.test(value) || MALFORMED_HEX_GUID.test(value) || UUID_WITH_TRAILING_JUNK.test(value);
}

function looksLikeMd5Hash(value: string): boolean {
  return LOWERCASE_HEX_32.test(value);
}

function looksLikeCodeIdentifier(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value)) return false;
  if (KNOWN_SECRET_PREFIX.test(value)) return false;
  if (CODE_IDENTIFIER_SUFFIX.test(value)) return true;
  const capitals = (value.match(/[A-Z]/g) ?? []).length;
  return capitals >= 3 && value.length >= 20 && !/\d/.test(value);
}

/** PEM header/footer line only — not a private key material match. */
function looksLikePemMarkerOnly(value: string): boolean {
  if (PEM_PRIVATE_KEY.test(value)) return false;
  if (value.length > 300 || /MII[A-Za-z0-9+/=]{20,}/.test(value)) return false;
  return /^-{4,5}(?:BEGIN|END)\s+.*PRIVATE KEY/i.test(value);
}

function looksLikeGitRemoteFragment(value: string): boolean {
  return /git@[a-z0-9.-]+\.(?:com|org)|ssh:\/\/git@|https:\/\/git@/i.test(value);
}

/** Gitleaks captured `key: value` / `KEY=value` instead of the secret alone. */
function looksLikeConfigAssignmentCapture(value: string): boolean {
  if (/:\s*[A-Za-z][A-Za-z0-9_]*\s*\|/.test(value)) return true;
  if (/^[A-Za-z][A-Za-z0-9_]*:\s/.test(value)) return true;
  const rhs = extractAssignmentRhs(value);
  if (rhs && looksLikePlaceholderToken(rhs)) return true;
  if (/\b(?:KeyPrefix|ProjectToken|ApiKey)\b/i.test(value) && value.includes(':')) return true;
  return false;
}

/** High-entropy base64 fragments with no provider prefix (common generic gitleaks FP). */
function looksLikeOpaqueBase64Blob(value: string): boolean {
  if (value.length < OPAQUE_BASE64_MIN_LEN) return false;
  if (!BASE64_ALPHABET.test(value)) return false;
  if (KNOWN_SECRET_PREFIX.test(value)) return false;
  return true;
}

/**
 * Reject secret values that do not look like standalone credentials.
 * PEM private keys with full blocks are exempt.
 */
export function isInvalidSecretShape(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (isRedactedPlaceholder(v)) return true;
  if (looksLikePlaceholderToken(v)) return true;
  const assignmentRhs = extractAssignmentRhs(v);
  if (assignmentRhs && looksLikePlaceholderToken(assignmentRhs)) return true;
  if (PEM_PRIVATE_KEY.test(v)) return false;
  if (looksLikeAwsSecretAccessKey(v)) {
    if (STRUCTURAL_CHARS_STRICT.test(v)) return true;
  } else if (STRUCTURAL_CHARS.test(v)) {
    return true;
  }
  if (hasTrailingCaptureJunk(v)) return true;
  if (hasLeadingBackslashCaptureJunk(v)) return true;
  if (hasLeadingDotCaptureJunk(v)) return true;
  const awsKey = looksLikeAwsSecretAccessKey(v);
  if (!awsKey && looksLikePathFragment(v)) return true;
  if (!awsKey && endsWithBase64Slash(v)) return true;
  if (looksLikeHexGuid(v)) return true;
  if (looksLikeDashedHexFragment(v)) return true;
  if (looksLikeMd5Hash(v)) return true;
  if (looksLikeCodeIdentifier(v)) return true;
  if (looksLikePemMarkerOnly(v)) return true;
  if (looksLikeGitRemoteFragment(v)) return true;
  if (looksLikeConfigAssignmentCapture(v)) return true;
  return looksLikeOpaqueBase64Blob(v);
}
