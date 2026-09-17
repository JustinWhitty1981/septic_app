import * as jwt from 'jsonwebtoken';
import { UserRole } from '../models/User';

export interface JwtPayload {
  userId: number;
  email: string;
  role: UserRole;
  // AUT-11: the users.tokens_epoch in force when this token was minted.
  // `authenticate` refuses the token once the column has moved past it.
  ep: number;
}

export const generateToken = (payload: JwtPayload): string => {
  const secret = process.env.JWT_SECRET || 'dev-secret-change-in-production';
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  
  return jwt.sign(payload, secret, { expiresIn: expiresIn as any });
};

export const verifyToken = (token: string): JwtPayload | null => {
  try {
    const secret = process.env.JWT_SECRET || 'dev-secret-change-in-production';
    return jwt.verify(token, secret) as JwtPayload;
  } catch (error) {
    return null;
  }
};

export const passwordValidation = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSpecialChar: true,
  
  isValid(password: string): boolean {
    if (password.length < this.minLength) return false;
    if (this.requireUppercase && !/[A-Z]/.test(password)) return false;
    if (this.requireLowercase && !/[a-z]/.test(password)) return false;
    if (this.requireNumber && !/[0-9]/.test(password)) return false;
    // AUT-06: "special" means any character that is not a letter or a digit.
    // The previous class [!@#$%^&*(),.?":{}|<>] rejected `Passw0rd_one` purely
    // for its underscore — the single most common symbol in a typed password —
    // and silently ruled out _ - + / = ; [ ] ~ ' ` \ and space. The stated
    // rules (length, upper, lower, digit, one non-alphanumeric) never implied
    // a whitelist of fourteen glyphs.
    if (this.requireSpecialChar && !/[^A-Za-z0-9]/.test(password)) return false;
    return true;
  },
  
  getRequirements(): string[] {
    const requirements: string[] = [];
    if (this.minLength > 0) requirements.push(`At least ${this.minLength} characters`);
    if (this.requireUppercase) requirements.push('At least one uppercase letter');
    if (this.requireLowercase) requirements.push('At least one lowercase letter');
    if (this.requireNumber) requirements.push('At least one number');
    if (this.requireSpecialChar) requirements.push('At least one character that is not a letter or a digit');
    return requirements;
  },
};
