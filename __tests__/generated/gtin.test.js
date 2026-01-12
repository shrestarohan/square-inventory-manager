const { normalizeDigits, canonicalGtin, canonicalizeQuery } = require('../../lib/gtin');

describe('lib/gtin', () => {
  describe('normalizeDigits', () => {
    test('returns empty string for null/undefined', () => {
      expect(normalizeDigits(null)).toBe('');
      expect(normalizeDigits(undefined)).toBe('');
    });

    test('removes whitespace and non-digit characters', () => {
      expect(normalizeDigits('  (123) 456-7890  ')).toBe('1234567890');
      expect(normalizeDigits(' 12 3-45a6')).toBe('123456');
    });

    test('works with numbers by coercion to string', () => {
      expect(normalizeDigits(12345)).toBe('12345');
    });
  });

  describe('canonicalGtin', () => {
    test('returns empty string for inputs that normalize to empty', () => {
      expect(canonicalGtin('')).toBe('');
      expect(canonicalGtin('abc')).toBe('');
    });

    test('keeps 8-digit GTINs as-is', () => {
      expect(canonicalGtin('12345678')).toBe('12345678');
      // with surrounding noise
      expect(canonicalGtin('  1234 5678 ')).toBe('12345678');
    });

    test('collapses to last 8 when prefix (everything before last 8) is all zeros', () => {
      // 12-digit with all-zero prefix (first 4 zeros) -> collapse to last8
      expect(canonicalGtin('000002785123')).toBe('02785123');

      // with spaces and other non-digits: normalization should remove them first
      expect(canonicalGtin(' 0000-08240402 ')).toBe('08240402');

      // 14-digit example: prefix length 6 zeros -> collapse
      expect(canonicalGtin('00000012345678')).toBe('12345678');
    });

    test('does not collapse when prefix is not all zeros', () => {
      // prefix '0084' is not all zeros -> unchanged
      expect(canonicalGtin('008421372232')).toBe('008421372232');

      // prefix contains a non-zero somewhere -> unchanged
      expect(canonicalGtin('00010000123456')).toBe('00010000123456');
    });

    test('returns shorter-than-8 digit strings unchanged', () => {
      expect(canonicalGtin('123')).toBe('123');
      expect(canonicalGtin('000123')).toBe('000123');
    });
  });

  describe('canonicalizeQuery', () => {
    test('delegates to canonicalGtin behavior', () => {
      const samples = [
        ['000002785123', '02785123'],
        ['  (123) 456-7890 ', '1234567890'],
        ['008421372232', '008421372232'],
        ['abc', ''],
      ];

      for (const [input, expected] of samples) {
        expect(canonicalizeQuery(input)).toBe(canonicalGtin(input));
        expect(canonicalizeQuery(input)).toBe(expected);
      }
    });
  });
});
