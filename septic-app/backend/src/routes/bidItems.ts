import { Router } from 'express';
import { bidItemsController } from '../controllers/bidItems.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * The master price list (BIL-09). The read is open — a price list is not a
 * secret, and every screen that quotes one needs it — and the writes are
 * office-only, because a number the office changes becomes a number on the
 * next bid. No DELETE is mounted: retirement is the delete this table allows.
 */
const router = Router();

router.use(authenticate);

const OFFICE = ['admin', 'manager', 'office'] as const;

router.get('/', bidItemsController.list);
router.post('/', authorize(...OFFICE), bidItemsController.create);
router.patch('/:id', authorize(...OFFICE), bidItemsController.update);

export default router;
