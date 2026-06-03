/**
 * PHI Guard — detect and redact Protected Health Information before storage/logging.
 *
 * HIPAA §164.502: PHI must not be disclosed except as permitted.
 * This module scans text for common PHI patterns (SSN, DOB, MRN, phone,
 * email, patient names in clinical context) and redacts them.
 *
 * Detection events are logged to stderr (picked up by DD agent) with
 * the pattern type and character position — never the actual PHI value.
 *
 * Usage:
 *   import { scanAndRedactPHI, hasPHI } from './phiGuard.js';
 *   const { redacted, detections } = scanAndRedactPHI(userText);
 *   // `redacted` is safe to store/log; `detections` lists what was found
 */

import { debugLog } from './logger.js';

export interface PHIDetection {
  type: string;
  position: number;
  length: number;
}

export interface PHIScanResult {
  redacted: string;
  detections: PHIDetection[];
  hasPHI: boolean;
}

// Patterns ordered by specificity (most specific first)
const PHI_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  // SSN: 123-45-6789 or 123456789
  { name: 'SSN', regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN-REDACTED]' },
  { name: 'SSN', regex: /\b\d{9}\b(?=\s|$|[,.])/g, replacement: '[SSN-REDACTED]' },

  // Date of birth patterns: DOB: 01/15/1990, born 1990-01-15, birthday 01/15/90
  { name: 'DOB', regex: /\b(?:dob|date\s*of\s*birth|born|birthday)\s*[:=]?\s*\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}\b/gi, replacement: '[DOB-REDACTED]' },
  { name: 'DOB', regex: /\b(?:dob|date\s*of\s*birth|born|birthday)\s*[:=]?\s*\d{4}[/\-]\d{1,2}[/\-]\d{1,2}\b/gi, replacement: '[DOB-REDACTED]' },

  // Medical Record Number: MRN: 12345678, MRN#12345
  { name: 'MRN', regex: /\b(?:mrn|medical\s*record)\s*[#:=]?\s*\d{4,12}\b/gi, replacement: '[MRN-REDACTED]' },

  // US Phone: (301) 433-1943, 301-433-1943, +1-301-433-1943
  { name: 'PHONE', regex: /\b(?:\+?1[-.]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[PHONE-REDACTED]' },

  // Email in clinical context: patient email, client email
  { name: 'EMAIL', regex: /\b(?:patient|client|parent|caregiver)\s*(?:email|e-mail)\s*[:=]?\s*[\w.+-]+@[\w.-]+\.\w{2,}\b/gi, replacement: '[EMAIL-REDACTED]' },

  // Patient/client name patterns: "Patient: John Doe", "Client Name: Jane Smith"
  { name: 'PATIENT_NAME', regex: /\b(?:patient|client)\s*(?:name)?\s*[:=]\s*[A-Z][a-z]+\s+[A-Z][a-z]+/gi, replacement: '[NAME-REDACTED]' },

  // Insurance ID: Ins#, Policy#, Member ID
  { name: 'INSURANCE_ID', regex: /\b(?:ins(?:urance)?|policy|member)\s*(?:id|#|number)\s*[:=]?\s*[A-Z0-9]{6,20}\b/gi, replacement: '[INSURANCE-REDACTED]' },

  // Diagnosis codes in patient context: "diagnosed with F84.0", "ICD: F32.1"
  { name: 'DIAGNOSIS', regex: /\b(?:diagnos\w*|icd|dx)\s*(?:[:=]|with)?\s*[A-Z]\d{2}(?:\.\d{1,2})?\b/gi, replacement: '[DX-REDACTED]' },
];

/**
 * Scan text for PHI patterns and return redacted version + detection list.
 * Never logs or stores the actual PHI values — only type + position.
 */
export function scanAndRedactPHI(text: string): PHIScanResult {
  if (typeof text !== 'string' || !text) {
    return { redacted: text || '', detections: [], hasPHI: false };
  }

  const detections: PHIDetection[] = [];
  let redacted = text;

  for (const { name, regex, replacement } of PHI_PATTERNS) {
    // Reset regex state for global patterns
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      detections.push({
        type: name,
        position: match.index,
        length: match[0].length,
      });
    }
    redacted = redacted.replace(regex, replacement);
  }

  if (detections.length > 0) {
    // Log detection event — type + count only, NEVER the actual value
    const summary = detections.reduce((acc, d) => {
      acc[d.type] = (acc[d.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const summaryStr = Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(' ');
    debugLog(`[PHI-GUARD] Detected and redacted PHI: ${summaryStr}`);
  }

  return {
    redacted,
    detections,
    hasPHI: detections.length > 0,
  };
}

/**
 * Quick check — does the text contain PHI patterns?
 * Faster than full redaction when you only need a boolean.
 */
export function hasPHI(text: string): boolean {
  if (typeof text !== 'string' || !text) return false;
  for (const { regex } of PHI_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}
