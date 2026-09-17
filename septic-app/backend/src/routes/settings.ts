import { Router } from 'express';
import { settingsController } from '../controllers/settings.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * Company settings (0027's table; BIL-16's rate). Reads open, writes office:
 * a percentage is public information, changing it is a decision about what
 * customers pay, and `updated_by` is there precisely so the decision has a
 * name attached when it comes up later.
 */
const router = Router();

router.use(authenticate);

const OFFICE = ['admin', 'manager', 'office'] as const;

router.get('/', settingsController.get);
router.patch('/sales-tax', authorize(...OFFICE), settingsController.setSalesTax);
router.patch('/payment-terms', authorize(...OFFICE), settingsController.setPaymentTerms);
router.patch('/company', authorize(...OFFICE), settingsController.setCompany);

export default router;
