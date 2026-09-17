import { Router } from 'express';
import { bidsController } from '../controllers/bids.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * Bids (BIL-10..16). Same split as every other surface here: reads open to any
 * authenticated user, writes office-only. A driver does not author quotes, for
 * the same reason a driver does not author routes — the office holds the
 * whole-day (and whole-customer) view, and the signature on a bid is exactly
 * as consequential as the sequence on a day.
 */
const router = Router();

router.use(authenticate);

const OFFICE = ['admin', 'manager', 'office'] as const;

router.get('/', bidsController.list);
router.get('/:id', bidsController.detail);

router.post('/', authorize(...OFFICE), bidsController.create);
// '/:id/lines' before nothing shadows it: unlike /drivers, every line route is
// two segments deep and '/:id' cannot reach it by accident.
router.post('/:id/lines', authorize(...OFFICE), bidsController.addLine);
router.patch('/:id/lines/:lineId', authorize(...OFFICE), bidsController.updateLine);
router.delete('/:id/lines/:lineId', authorize(...OFFICE), bidsController.removeLine);
router.post('/:id/approve', authorize(...OFFICE), bidsController.approve);
router.post('/:id/decline', authorize(...OFFICE), bidsController.decline);
router.post('/:id/convert', authorize(...OFFICE), bidsController.convert);

export default router;
