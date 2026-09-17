import { Router } from 'express';
import { quarantineController } from '../controllers/quarantine.controller';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

/**
 * The one route file in the app that distinguishes between roles, and the first place
 * `authorize` is actually used — it had been sitting in middleware/auth.ts unused since the
 * old routes that called it were deleted.
 *
 * Reads are open to any authenticated user. A driver who sees a site's history can see that
 * part of its record failed to import; that is not information worth hiding from the person
 * standing at the tank, and hiding it would make the queue look like a clean dataset.
 *
 * Writes are not. `authorize('admin', 'manager', 'office')` excludes `driver`, for one
 * reason: resolving a quarantine row is the act of declaring that a data-quality problem has
 * been dealt with, and the person whose job is to pump tanks is not the person who decides
 * whether the office's records are correct. A driver closing a row makes the row disappear
 * from the queue with no note and no history, and nothing in the schema would show who was
 * standing at the keyboard.
 *
 * This is a narrow decision, not the auth model. The property routes are still readable by a
 * driver token and the question of who may write a schedule is still open (DATA_MODEL §13).
 * What changed is that the first write endpoint in the app did not arrive without an answer
 * to "who is allowed to do this" — that question gets answered at the door, not later.
 */
router.use(authenticate);

const OFFICE = ['admin', 'manager', 'office'] as const;

router.get('/families', quarantineController.families);
router.get('/', quarantineController.list);

// ':id' is a bigint from a bigserial, so it is bounded by intParam in the controller rather
// than here — a URL that cannot name a row is answered from the URL, not from the database.
router.post('/:id/resolve', authorize(...OFFICE), quarantineController.resolve);
router.post('/:id/unresolve', authorize(...OFFICE), quarantineController.unresolve);

export default router;
