import { Router } from 'express';
import { correctEvent, stateReport, listEvents, ledgerLookups, recordServiceEvent, unbilledEvents } from '../controllers/ledger.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * The regulatory ledger's front door (LED-01, LED-02). The read and correct
 * endpoints are
 * office-gated, for the two reasons the quarantine writes already gave:
 * deciding that a regulatory record was wrong is office work, and the state
 * report is a company-wide aggregate a stolen tablet should not be able to
 * read in one request. The insert-only rule underneath them is not here — it
 * is in the database (0020), which is the only place "append-only" is worth
 * writing down.
 */
const router = Router();

router.use(authenticate);

const OFFICE = ['admin', 'manager', 'office'] as const;

/**
 * DRV-20: filing unscheduled work is NOT office-gated — the driver standing
 * at the house is the person the requirement was written for, and a role
 * check here would send real work back to the office's queue by one door
 * that exists precisely because the office could not see it. The GET of the
 * same path stays OFFICE: reading the ledger's history is a different act
 * from reporting one's own afternoon.
 */
router.post('/events', recordServiceEvent);

router.get('/report', authorize(...OFFICE), stateReport);
router.get('/events', authorize(...OFFICE), listEvents);
// BIL-19: the billing queue. Office-gated like every screen that names
// customers and money; the driver already knows what they pumped.
router.get('/unbilled-events', authorize(...OFFICE), unbilledEvents);
router.get('/lookups', authorize(...OFFICE), ledgerLookups);
router.post('/:id/correct', authorize(...OFFICE), correctEvent);

export default router;
