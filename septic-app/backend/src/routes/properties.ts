import { Router } from 'express';
import { propertiesController } from '../controllers/property.controller';
import { assignPayer, listOwners } from '../controllers/owner.controller';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// All routes require authentication.
//
// No role check yet, so a driver token reaches the same data an office login does.
// That is open work, not an oversight to close silently here: the routes that used to
// be mounted beside these were worse, and the fix is a decision about who may see a
// customer list, which belongs with the rest of the auth hardening.
router.use(authenticate);

// Order matters: '/due-queue' and '/search' must be matched before '/:id', which would
// otherwise answer them with "id must be a positive integer".
router.get('/search', propertiesController.search);
router.get('/due-queue', propertiesController.dueQueue);
router.get('/', propertiesController.getAll);

// The writes (SCH-11) are office-gated: a site is what the bill, the route and
// the ledger hang on, so the person creating one is the person doing office
// work. Still no DELETE anywhere on this surface — the honest retire is
// `status`; `service_events` name a property under a RESTRICT FK, and a site
// that was ever pumped cannot be un-pumped by deleting its hub.
router.post('/', authorize('admin', 'manager', 'office'), propertiesController.create);
router.patch('/:id', authorize('admin', 'manager', 'office'), propertiesController.update);
// SCH-16: overlay rows on the schedule, not edits to it. Office-side verbs —
// a driver disputing a due date has a truck and a phone, not paperwork.
router.post('/:id/due-adjustments', authorize('admin', 'manager', 'office'), propertiesController.createDueAdjustment);
router.delete('/:id/due-adjustments', authorize('admin', 'manager', 'office'), propertiesController.deleteDueAdjustment);

router.get('/:id', propertiesController.getById);

// One write predates SCH-11 and keeps its own comment: "who owns this site"
// is the only fact about a site that changes by *event* rather than by edit,
// and an event gets a new row (SCH-06) — which is why it too is office-gated:
// closing somebody's ownership record is a decision with a paper trail, not
// a typo fix.
router.get('/:id/owners', authorize('admin', 'manager', 'office'), listOwners);
router.post('/:id/owners', authorize('admin', 'manager', 'office'), assignPayer);

export default router;
