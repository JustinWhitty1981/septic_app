import { passwordValidation } from '../src/config/auth';
import { hashPassword, comparePassword } from '../src/utils/password';

// AUT-06 — the policy must accept every password a reasonable person could type.
// These cases are written as the *intent*, then pinned to current behaviour so a
// future change to the character class cannot silently alter what users can type.
describe('AUT-06: password policy', () => {
  it('accepts a strong, ordinary password', () => {
    expect(passwordValidation.isValid('Correc7-Passw0rd!')).toBe(true);
  });

  it('rejects too short', () => {
    expect(passwordValidation.isValid('Ab1!xyz')).toBe(false);
  });

  it('rejects missing uppercase / lowercase / digit / symbol', () => {
    expect(passwordValidation.isValid('alllowercase1!')).toBe(false);
    expect(passwordValidation.isValid('ALLUPPERCASE1!')).toBe(false);
    expect(passwordValidation.isValid('NoDigitsHere!')).toBe(false);
    expect(passwordValidation.isValid('NoSymbolsHere1')).toBe(false);
  });

  // AUT-06 closed 2026-08-30: "special" became *any character that is not a
  // letter or a digit*. These are the symbols the old fourteen-glyph class
  // silently ruled out; each one is now accepted for exactly the reason it used
  // to be refused, which is to say: for no reason at all.
  it('accepts every non-alphanumeric a reasonable person could type', () => {
    for (const sym of ['_', '-', '+', '/', '=', ';', '[', ']', '~', "'", '`', '\\', ' ']) {
      expect(passwordValidation.isValid(`Passw0rd${sym}x`)).toBe(true);
    }
  });

  it('still refuses what the stated rules forbid: pure alphanumeric', () => {
    expect(passwordValidation.isValid('Passw0rdonly')).toBe(false);
  });

  it('reports requirements the UI can show verbatim', () => {
    expect(passwordValidation.getRequirements()).toHaveLength(5);
  });
});

describe('password hashing', () => {
  it('produces different hashes for the same input (salted)', async () => {
    const a = await hashPassword('Correc7-Passw0rd!');
    const b = await hashPassword('Correc7-Passw0rd!');
    expect(a).not.toBe(b);
  });

  it('compares true for the matching password, false otherwise', async () => {
    const hash = await hashPassword('Correc7-Passw0rd!');
    expect(await comparePassword('Correc7-Passw0rd!', hash)).toBe(true);
    expect(await comparePassword('Correc7-Passw0rd?', hash)).toBe(false);
  });

  it('never stores the plaintext', async () => {
    const hash = await hashPassword('Correc7-Passw0rd!');
    expect(hash).not.toContain('Correc7');
    expect(hash.startsWith('$2b$12$')).toBe(true);
  });
});
