import { Router } from 'express';
import { listReceivables } from '../controllers/receivables.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * Who owes money (BIL-07). Office-gated: a receivables list is the company's
 * entire outstanding book in one screen, and a driver's tablet has no reason
 * to hold it.
 */
const router = Router();

router.use(authenticate, authorize('admin', 'manager', 'office'));

router.get('/', listReceivables);

export default router;
