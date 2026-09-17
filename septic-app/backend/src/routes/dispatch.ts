import { Router } from 'express';
import { dispatchController } from '../controllers/dispatch.controller';
import { authenticate } from '../middleware/auth';

/**
 * The driver's launch endpoint. One route, one method, and deliberately no role gate beyond
 * `authenticate`.
 *
 * It is the only endpoint in the app whose audience is a tablet in a driveway, and it is the
 * only one that answers for the person holding it rather than for a resource they named. There
 * is no `/:id` here and no `?driver_id=` — the token decides whose day this is, so a lost
 * tablet reveals one route rather than seven. The office reads a specific day at
 * `/api/routes/:id`, which is gated on a role.
 *
 * Everything about the payload — offline caching, one round trip, drafts excluded — lives in
 * the controller, where the query that produces it is visible.
 *
 * The `PATCH` below is the same rule pointed the other way: a driver writes their own stop,
 * and still cannot name the driver whose stop it is.
 */
const router = Router();

router.use(authenticate);

router.get('/today', dispatchController.today);
router.patch('/stops/:id/status', dispatchController.updateStop);

export default router;
