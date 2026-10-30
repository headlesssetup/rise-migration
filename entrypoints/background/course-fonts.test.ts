import { describe, it, expect } from 'vitest';
import { decodeRiseTypefaceFamily } from './course-fonts';

describe('decodeRiseTypefaceFamily', () => {
  it('decodes the 6-hex-digit code points of a rise-tf family (mig30oct console capture)', () => {
    const fam =
      'rise-tf-00004700003400005000003800007700003500007600005700003500006100007400003000003400007400004a00003900005700006200007500007100003600004c000045000053';
    expect(decodeRiseTypefaceFamily(fam)).toBe('G4P8w5vW5at04tJ9Wbuq6LES');
    expect(decodeRiseTypefaceFamily(`"${fam}"`)).toBe('G4P8w5vW5at04tJ9Wbuq6LES');
  });
  it('rejects anything else', () => {
    expect(decodeRiseTypefaceFamily('Lato')).toBeNull();
    expect(decodeRiseTypefaceFamily('rise-tf-00004')).toBeNull();
  });
});
