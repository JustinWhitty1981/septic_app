import { Request, Response } from 'express';
import { User, UserRole } from '../models/User';
import { AppDataSource } from '../config/database';
import { hashPassword, comparePassword } from '../utils/password';
import { generateToken, passwordValidation } from '../config/auth';
import { internalError } from '../utils/errors';

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { first_name, last_name, email, password } = req.body;

    // Validate input
    if (!first_name || !last_name || !email || !password) {
      res.status(400).json({ error: 'All fields are required' });
      return;
    }

    // SECURITY: the role is deliberately NOT read from req.body.
    //
    // This route is public (routes/auth.ts mounts it with no authenticate
    // middleware) and previously did `role: role || 'technician'`, so anyone who
    // could reach it could POST {"role":"admin"} and mint themselves an
    // administrator. The frontend never calls /register -- it only calls /login.
    //
    // Self-registration therefore yields the lowest-privilege role that still has a
    // use: a driver. Staff accounts are created by an authenticated admin once the
    // user-management screen exists, or with scripts/seed-user.ts for bootstrap.
    const role: UserRole = 'driver';

    // Validate password
    if (!passwordValidation.isValid(password)) {
      res.status(400).json({ 
        error: 'Password does not meet requirements',
        requirements: passwordValidation.getRequirements()
      });
      return;
    }

    // Check if user already exists
    const userRepository = AppDataSource.getRepository(User);
    const existingUser = await userRepository.findOne({ where: { email } });

    if (existingUser) {
      res.status(409).json({ error: 'User with this email already exists' });
      return;
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const user = userRepository.create({
      first_name,
      last_name,
      email,
      password_hash: passwordHash,
      role,
      is_active: true
    });

    await userRepository.save(user);

    // Generate token
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      ep: user.tokens_epoch ?? 0,
    });

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const userRepository = AppDataSource.getRepository(User);
    const user = await userRepository.findOne({ where: { email } });

    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({ error: 'Account is deactivated' });
      return;
    }

    const isValidPassword = await comparePassword(password, user.password_hash);

    if (!isValidPassword) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Narrow UPDATE rather than save(user): a full-row write would clobber any
    // column another device changed between our read and this write.
    await userRepository.update(user.id, { last_login_at: new Date() });

    // Generate token
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      ep: user.tokens_epoch,
    });

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  // AUT-11. This used to answer 200 and do nothing, so "logging out" a lost
  // tablet was theatre: the token stayed valid for the full expiry. The
  // revocation state is a counter, not a timestamp — see 0019 for the
  // second-resolution ambiguity that ruled the clock out. Incrementing it
  // kills every session the account currently has, including this one, which
  // is the semantics wanted for a shared tablet: "nobody is logged in here".
  try {
    await AppDataSource.query(
      'UPDATE users SET tokens_epoch = tokens_epoch + 1 WHERE id = $1',
      [req.user!.userId],
    );
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ error: internalError(error) });
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const userRepository = AppDataSource.getRepository(User);
    const user = await userRepository.findOne({ where: { id: req.user.userId } });

    if (!user || !user.is_active) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
