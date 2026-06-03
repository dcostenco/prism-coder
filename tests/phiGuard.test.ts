import { describe, it, expect } from 'vitest';
import { scanAndRedactPHI, hasPHI } from '../src/utils/phiGuard';

describe('PHI Guard', () => {

  // ── SSN Detection ──────────────────────────────────────────────────

  it('detects and redacts SSN with dashes', () => {
    const { redacted, hasPHI: found } = scanAndRedactPHI('SSN is 123-45-6789');
    expect(found).toBe(true);
    expect(redacted).toContain('[SSN-REDACTED]');
    expect(redacted).not.toContain('123-45-6789');
  });

  it('does not flag non-SSN numbers', () => {
    const { hasPHI: found } = scanAndRedactPHI('Build 29, version 1.0.0');
    expect(found).toBe(false);
  });

  // ── DOB Detection ──────────────────────────────────────────────────

  it('detects DOB: MM/DD/YYYY', () => {
    const { redacted, hasPHI: found } = scanAndRedactPHI('DOB: 01/15/1990');
    expect(found).toBe(true);
    expect(redacted).toContain('[DOB-REDACTED]');
  });

  it('detects "born 1990-01-15"', () => {
    const { redacted, hasPHI: found } = scanAndRedactPHI('Patient born 1990-01-15');
    expect(found).toBe(true);
    expect(redacted).toContain('[DOB-REDACTED]');
  });

  it('does not flag generic dates', () => {
    const { hasPHI: found } = scanAndRedactPHI('Meeting on 2026-06-03');
    expect(found).toBe(false);
  });

  // ── MRN Detection ──────────────────────────────────────────────────

  it('detects MRN#12345678', () => {
    const { redacted, hasPHI: found } = scanAndRedactPHI('MRN#12345678');
    expect(found).toBe(true);
    expect(redacted).toContain('[MRN-REDACTED]');
  });

  it('detects "medical record: 987654"', () => {
    const { redacted } = scanAndRedactPHI('medical record: 987654');
    expect(redacted).toContain('[MRN-REDACTED]');
  });

  // ── Phone Detection ────────────────────────────────────────────────

  it('detects (301) 433-1943', () => {
    const { redacted, hasPHI: found } = scanAndRedactPHI('Call (301) 433-1943');
    expect(found).toBe(true);
    expect(redacted).toContain('[PHONE-REDACTED]');
  });

  it('detects 301-433-1943', () => {
    const { redacted } = scanAndRedactPHI('Phone: 301-433-1943');
    expect(redacted).toContain('[PHONE-REDACTED]');
  });

  // ── Patient Name Detection ─────────────────────────────────────────

  it('detects "Patient: John Doe"', () => {
    const { redacted, hasPHI: found } = scanAndRedactPHI('Patient: John Doe');
    expect(found).toBe(true);
    expect(redacted).toContain('[NAME-REDACTED]');
    expect(redacted).not.toContain('John Doe');
  });

  it('detects "Client Name: Jane Smith"', () => {
    const { redacted } = scanAndRedactPHI('Client Name: Jane Smith');
    expect(redacted).toContain('[NAME-REDACTED]');
  });

  it('does not flag generic names', () => {
    const { hasPHI: found } = scanAndRedactPHI('Alex is a good voice');
    expect(found).toBe(false);
  });

  // ── Insurance ID Detection ─────────────────────────────────────────

  it('detects "Insurance ID: ABC123456789"', () => {
    const { redacted } = scanAndRedactPHI('Insurance ID: ABC123456789');
    expect(redacted).toContain('[INSURANCE-REDACTED]');
  });

  // ── Diagnosis Code Detection ───────────────────────────────────────

  it('detects "diagnosed with F84.0"', () => {
    const { redacted, hasPHI: found } = scanAndRedactPHI('diagnosed with F84.0');
    expect(found).toBe(true);
    expect(redacted).toContain('[DX-REDACTED]');
  });

  it('detects "ICD: F32.1"', () => {
    const { redacted } = scanAndRedactPHI('ICD: F32.1');
    expect(redacted).toContain('[DX-REDACTED]');
  });

  // ── Email in clinical context ──────────────────────────────────────

  it('detects "patient email: john@example.com"', () => {
    const { redacted } = scanAndRedactPHI('patient email: john@example.com');
    expect(redacted).toContain('[EMAIL-REDACTED]');
  });

  it('does not flag generic email', () => {
    const { hasPHI: found } = scanAndRedactPHI('Contact support@synalux.ai');
    expect(found).toBe(false);
  });

  // ── Multiple PHI in one text ───────────────────────────────────────

  it('detects and redacts multiple PHI types', () => {
    const text = 'Patient: John Doe, DOB: 03/15/1985, SSN 123-45-6789, MRN#5678901';
    const { redacted, detections, hasPHI: found } = scanAndRedactPHI(text);
    expect(found).toBe(true);
    expect(detections.length).toBeGreaterThanOrEqual(3);
    expect(redacted).not.toContain('John Doe');
    expect(redacted).not.toContain('123-45-6789');
    expect(redacted).not.toContain('5678901');
  });

  // ── Safe text ──────────────────────────────────────────────────────

  it('returns clean text unchanged', () => {
    const safe = 'Build the app and run tests on simulator';
    const { redacted, hasPHI: found } = scanAndRedactPHI(safe);
    expect(found).toBe(false);
    expect(redacted).toBe(safe);
  });

  it('handles empty/null input', () => {
    expect(scanAndRedactPHI('').hasPHI).toBe(false);
    expect(scanAndRedactPHI(null as any).hasPHI).toBe(false);
  });

  // ── hasPHI quick check ─────────────────────────────────────────────

  it('hasPHI returns true for SSN', () => {
    expect(hasPHI('SSN 123-45-6789')).toBe(true);
  });

  it('hasPHI returns false for safe text', () => {
    expect(hasPHI('fix the build error')).toBe(false);
  });

  // ── Redacted output never contains raw PHI ─────────────────────────

  it('CRITICAL: redacted output never leaks raw PHI', () => {
    const phiValues = [
      '123-45-6789',        // SSN
      'John Doe',           // Name
      '01/15/1990',         // DOB
      '12345678',           // MRN
      '301-433-1943',       // Phone
    ];
    const text = `Patient: John Doe, SSN 123-45-6789, DOB: 01/15/1990, MRN#12345678, phone 301-433-1943`;
    const { redacted } = scanAndRedactPHI(text);

    for (const val of phiValues) {
      expect(redacted).not.toContain(val);
    }
  });

  // ── Detection metadata never contains PHI ──────────────────────────

  it('CRITICAL: detection objects contain type+position only, never the value', () => {
    const { detections } = scanAndRedactPHI('Patient: John Doe, SSN 123-45-6789');
    for (const d of detections) {
      expect(Object.keys(d).sort()).toEqual(['length', 'position', 'type']);
      expect(typeof d.type).toBe('string');
      expect(typeof d.position).toBe('number');
      expect(typeof d.length).toBe('number');
      // No 'value', 'text', 'match', or 'raw' field
      expect((d as any).value).toBeUndefined();
      expect((d as any).text).toBeUndefined();
      expect((d as any).match).toBeUndefined();
    }
  });
});
