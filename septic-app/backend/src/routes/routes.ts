import { Router } from 'express';
import { routeController } from '../controllers/route.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * Scheduling. The second route file in the app that distinguishes between roles, and the
 * first one where the answer to "who may write this" was decided *before* the endpoint
 * existed rather than discovered by a test afterwards.
 *
 * Reads are open to any authenticated user, as they are for properties and the quarantine
 * queue: a driver who can see a site can see that a day was planned for it, and hiding the
 * schedule from the person who drives it is not a security decision, it is an inconvenience.
 *
 * Writes are office-only — the same `authorize(...OFFICE)` gate quarantine.ts established, for
 * the same reason. A driver does not author their own day. If a driver could add a stop, the
 * sequence the office decided would be a suggestion, and the reason the sequence exists at all
 * is that somebody with a whole-day view chose it.
 *
 * Note what is *not* here: no route ever moves to `in_progress` or `done` through this file.
 * Those belong to the driver's device (DRV-06), and an office keyboard writing them would be a
 * claim about where a truck is that nobody in the office can actually witness.
 */
const router = Router();

router.use(authenticate);

const OFFICE = ['admin', 'manager', 'office'] as const;

router.get('/', routeController.forDate);
// Before '/:id'. Registered after it, `/routes/drivers` matches `/:id` first, reaches
// intParam('drivers'), and answers a clerk looking for a person with "id must be a positive
// integer". Express matches in declaration order and does not care what you meant.
router.get('/drivers', routeController.drivers);
router.get('/:id', routeController.getById);

router.post('/', authorize(...OFFICE), routeController.create);
router.post('/:id/stops', authorize(...OFFICE), routeController.addStop);
// SCH-13: the same verb one level up, with the route named by (driver, date) instead
// of by id. Safe from the '/:id' shadowing that /drivers had to dodge: '/stops' is a
// single segment and every POST pattern carrying ':id' has two.
router.post('/stops', authorize(...OFFICE), routeController.scheduleSite);
router.patch('/:id/stops', authorize(...OFFICE), routeController.reorder);
router.delete('/:id/stops/:stopId', authorize(...OFFICE), routeController.removeStop);
router.post('/:id/publish', authorize(...OFFICE), routeController.publish);
router.post('/:id/unpublish', authorize(...OFFICE), routeController.unpublish);

export default router;
