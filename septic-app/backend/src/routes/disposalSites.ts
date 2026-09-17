import { Router } from 'express';
import { disposalSitesController } from '../controllers/disposalSites.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * Reference data for the one write the driver cannot complete without.
 *
 * `authenticate` and no role gate on the reads, on purpose: `PATCH
 * /api/dispatch/stops/:id/status` refuses `done` unless it names a real
 * `disposal_sites` row, so the list of those rows is part of the driver's
 * path, not the office's book. A role gate here would make a lawful pump-out
 * unsavable from a truck — the exact bug this endpoint was added to fix
 * (office-gate.test.ts pins the openness in `OPEN_READS`).
 *
 * The writes (LED-07) are office-gated: the vocabulary the compliance record
 * is judged against is edited by the office, which is the same sentence AGENTS
 * has said since the migration — "the office owns tidying that table".
 */
const router = Router();

router.use(authenticate);

router.get('/', disposalSitesController.list);

router.post('/', authorize('admin', 'manager', 'office'), disposalSitesController.create);

/* The default is a decision, and decisions belong to the office; the list
 * that carries it stays open to every role (see above). Declared before
 * '/:id' so PATCH /default is never swallowed as "rename the site named
 * default". */
router.patch('/default', authorize('admin', 'manager', 'office'), disposalSitesController.setDefault);

router.patch('/:id', authorize('admin', 'manager', 'office'), disposalSitesController.update);
router.delete('/:id', authorize('admin', 'manager', 'office'), disposalSitesController.remove);

export default router;
