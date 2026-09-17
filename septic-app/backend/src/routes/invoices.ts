import { Router } from 'express';
import { adjustInvoice, listInvoices, getInvoice, recordPayment, createInvoice } from '../controllers/invoice.controller';
import { authenticate, authorize } from '../middleware/auth';

/**
 * Billing corrections (BIL-05). Reads of the invoice book are not here yet
 * because nothing has asked for them; the correction path is, because the
 * legacy corpus is full of evidence of what its absence causes (BIL-03).
 */
const router = Router();

router.use(authenticate);

const OFFICE = ['admin', 'manager', 'office'] as const;

// Reading the book is office work for the same reason correcting it is: the
// invoice table names every customer and what they owe.
router.get('/', authorize(...OFFICE), listInvoices);
// BIL-20: creation is office work like everything else that bills a person.
router.post('/', authorize(...OFFICE), createInvoice);
router.get('/:id', authorize(...OFFICE), getInvoice);
router.post('/:id/adjust', authorize(...OFFICE), adjustInvoice);
router.post('/:id/payments', authorize(...OFFICE), recordPayment);

export default router;
