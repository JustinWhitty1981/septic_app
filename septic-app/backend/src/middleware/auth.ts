import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../config/auth';
import { UserRole } from '../models/User';
import { AppDataSource } from '../config/database';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const authenticate = (req: Request, res: Response, next: NextFunction): Promise<void> => {
  return authenticateOrOptional(req, res, next, false);
};

export const optionalAuth = (req: Request, res: Response, next: NextFunction): Promise<void> => {
  return authenticateOrOptional(req, res, next, true);
};

async function authenticateOrOptional(
  req: Request,
  res: Response,
  next: NextFunction,
  optional: boolean,
): Promise<void> {
  // One implementation for both gates. The old `optionalAuth` was a copy of
  // `authenticate` minus the 401s, which meant the AUT-11 revocation check
  // would have had to be maintained twice — in the exact function whose job is
  // to be lenient — and one day would not be.
  const fail = optional ? null : (): void => {
    res.status(401).json({ error: 'Authentication failed' });
  };

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      if (fail) fail();
      else next();
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) {
      if (fail) fail();
      else next();
      return;
    }

    // AUT-11. A signature check alone cannot answer "is this session still
    // allowed": logout and deactivation are facts about the account, not about
    // the bytes. One indexed SELECT per authenticated request — at two thousand
    // jobs a day, this is not the bottleneck, and every alternative (token
    // cache, short tokens + refresh) adds a component that can drift from the
    // database it claims to mirror.
    const accountRows = await AppDataSource.query(
      'SELECT is_active, tokens_epoch FROM users WHERE id = $1',
      [decoded.userId],
    );
    const account = accountRows[0];

    // A token minted before the epoch column existed carries no `ep`; treating
    // it as 0 revokes every pre-0019 session, which is exactly what a revocation
    // feature should do to the sessions that predate it.
    if (
      !account ||
      !account.is_active ||
      (decoded.ep ?? 0) < account.tokens_epoch
    ) {
      if (fail) fail();
      else next();
      return;
    }

    req.user = decoded;
    next();
  } catch (error) {
    // NF-08 discipline: the JWT never reaches this log line, and neither does
    // the identity attached to it.
    console.error('Authentication error:', (error as Error)?.message);
    if (fail) fail();
    else next();
  }
}

export const authorize = (...roles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // A previously present debug block logged req.user, req.user.role and the
    // allowed roles on *every* authorised request. That puts identities into the
    // container logs at scale and tells an attacker which role a token carries.

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
};
