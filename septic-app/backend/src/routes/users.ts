import { Router } from 'express';
import { createUser, setActive, resetPassword, listUsers } from '../controllers/user.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * Account administration (AUT-12) — the only router in the app gated to `admin`
 * alone. Every other OFFICE gate shares its role list with staff; this one does
 * not, because creating and disabling logins is not office work, it is control
 * over who gets to do office work.
 */
const router = Router();

router.use(authenticate, authorize('admin'));

router.get('/', listUsers);
router.post('/', createUser);
router.patch('/:id', setActive);
// AUT-12's third operation: set a new password. There is no self-service
// forgot-password to route to — no employee mail exists to carry a link.
router.post('/:id/password', resetPassword);

export default router;
