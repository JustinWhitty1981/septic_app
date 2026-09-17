import * as jwt from 'jsonwebtoken';
import { generateToken, verifyToken, JwtPayload } from '../src/config/auth';

const SECRET = process.env.JWT_SECRET;

// AUT-03 / AUT-04 — token acceptance. These are the properties that make a
// seven-day token on a shared tablet survivable; if any of them regresses the
// auth middleware silently starts accepting tokens it should not.
describe('AUT-03/AUT-04: token verification', () => {
  const payload: JwtPayload = { userId: 42, email: 'driver@septic.test', role: 'driver', ep: 0 };

  beforeAll(() => {
    // The compose file refuses to start without JWT_SECRET, so a missing secret
    // here means the harness is misconfigured, not that the code is wrong.
    expect(SECRET).toBeTruthy();
  });

  it('round-trips the claims it was given', () => {
    expect(verifyToken(generateToken(payload))).toMatchObject(payload);
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign(payload, 'not-the-real-secret');
    expect(verifyToken(forged)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign(payload, SECRET!, { expiresIn: '-1s' });
    expect(verifyToken(expired)).toBeNull();
  });

  it('rejects the string "none" as a signature (algorithm confusion)', () => {
    const unsigned = Buffer.from(
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
        '.' +
        Buffer.from(JSON.stringify(payload)).toString('base64url') +
        '.',
    ).toString();
    expect(verifyToken(unsigned)).toBeNull();
  });

  it('rejects a tampered payload that keeps a valid-looking shape', () => {
    const honest = generateToken(payload);
    const [header, , signature] = honest.split('.');
    const escalated = Buffer.from(
      JSON.stringify({ ...payload, role: 'admin' }),
    ).toString('base64url');
    expect(verifyToken(`${header}.${escalated}.${signature}`)).toBeNull();
  });

  it('rejects garbage and empty strings rather than throwing', () => {
    expect(verifyToken('')).toBeNull();
    expect(verifyToken('not.a.jwt')).toBeNull();
  });

  // A fallback secret is only safe if it cannot be reached by accident. If this
  // ever returns true, a deployment that forgot JWT_SECRET is signing tokens with
  // a value that is public in this repository.
  it('does not depend on the hardcoded development fallback secret', () => {
    const fallback = 'dev-secret-change-in-production';
    const withFallback = jwt.sign(payload, fallback);
    expect(verifyToken(withFallback)).toBeNull();
  });
});
