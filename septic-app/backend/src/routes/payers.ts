import { Router } from 'express';
import { searchPayers, createPayer } from '../controllers/payers.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * Payers, office-gated: the search names customers and what they own, and the
 * form adds one. The write stays separate from the search on purpose —
 * typing into search has never created a row and never will (SCH-12);
 * a biller is created by an office decision with a form behind it.
 */
const router = Router();

router.use(authenticate, authorize('admin', 'manager', 'office'));

router.get('/', searchPayers);
router.post('/', createPayer);

export default router;
