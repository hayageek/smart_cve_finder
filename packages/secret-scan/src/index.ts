export { runSecretScanGate } from './scan.js';
export type { SecretCandidate, SecretScanGateResult, SecretScanOptions, VerifyStatus } from './scan.js';
export { redactSecret } from './redact.js';
export { isExcludedPath, resetExclusionCache } from './exclusions.js';
export { isInvalidSecretShape } from './validate.js';
export { defaultConfigPath, runGitleaksScan } from './gitleaks.js';
export { runTrufflehogVerify } from './trufflehog.js';
