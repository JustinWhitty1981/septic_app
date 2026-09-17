import { Router } from 'express';
import authRoutes from './auth';
import propertiesRoutes from './properties';
import quarantineRoutes from './quarantine';
import routesRoutes from './routes';
import dispatchRoutes from './dispatch';
import usersRoutes from './users';
import ledgerRoutes from './ledger';
import invoicesRoutes from './invoices';
import notesRoutes from './notes';
import mediaRoutes from './media';
import payersRoutes from './payers';
import receivablesRoutes from './receivables';
import disposalSitesRoutes from './disposalSites';
import settingsRoutes from './settings';
import bidItemsRoutes from './bidItems';
import bidsRoutes from './bids';

const router = Router();

/**
 * Four route files were deleted here: /customers, /appointments, /inventory and
 * /compliance, together with their controllers — roughly 2,600 lines.
 *
 * They were not failing. They were answering, correctly, about tables that no longer
 * exist. `customers`, `appointments`, `inventory_items`, `suppliers`,
 * `purchase_orders`, `septic_tank_records` and `wisconsin_state_reports` were all
 * excluded from the new schema on purpose (DATA_MODEL §12): the inventory tables had
 * zero legacy rows, and the compliance calendar modelled a tank-inspection schedule
 * the business does not run. Keeping the routes to keep the frontend quiet would have
 * meant keeping the tables to keep the routes, which is how the old schema got here.
 *
 * The frontend still calls all of them. Those screens now 404 instead of 500, which is
 * the honest direction: a missing feature says so, a broken one invents an error.
 */
router.use('/auth', authRoutes);
router.use('/disposal-sites', disposalSitesRoutes);
router.use('/settings', settingsRoutes);
router.use('/bid-items', bidItemsRoutes);
router.use('/bids', bidsRoutes);
router.use('/properties', propertiesRoutes);
router.use('/quarantine', quarantineRoutes);

/**
 * `/routes` is the office building a day; `/dispatch` is a driver reading theirs. They are
 * separate files because they have different audiences and one different rule: the office
 * names a resource and asks about it, and the driver asks about themselves. Merging them would
 * put a `?driver_id=` one refactor away from the endpoint a stolen tablet calls.
 */
router.use('/routes', routesRoutes);
router.use('/dispatch', dispatchRoutes);

/**
 * Account administration. Admin-only — see the comment in users.ts for why this
 * router does not share the OFFICE list.
 */
router.use('/users', usersRoutes);

/**
 * The append-only ledger and its correction surface (LED-01/02), and the
 * invoice book's correction path (BIL-05). The enforcement lives in the
 * database; these files only decide who may ask.
 */
router.use('/ledger', ledgerRoutes);
router.use('/invoices', invoicesRoutes);

/**
 * Field notes (DRV-14). Append-only: the device's observations are never
 * merged, edited, or overwritten — two tablets that both saw a cracked lid
 * produce two notes, and that is the true record. `/media` is mounted in
 * `server.ts` before the global JSON parser (photos need a larger, per-route
 * limit); only notes live here.
 */
router.use('/notes', notesRoutes);
router.use('/payers', payersRoutes);
router.use('/receivables', receivablesRoutes);

/**
 * Photos (DRV-15b/16/17/18). Any authenticated role — the camera is on the
 * truck — and deliberately absent from the OFFICE gate. The upload route
 * carries its own 16 MB body parser; `server.ts` excepts this path from the
 * global 100 KB one, because the first parser to touch a stream owns it.
 */
router.use('/media', mediaRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
