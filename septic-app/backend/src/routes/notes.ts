import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { createNote, listNotes } from '../controllers/notes.controller';

const router = Router();

/**
 * Field notes: append-only by construction (DRV-14). Any authenticated role;
 * the device side is the point. There is no PATCH/DELETE on purpose — a note
 * that could be edited is a note that will be edited after the dispute starts,
 * and the ledger learned where that ends.
 */
router.post('/', authenticate, createNote);
router.get('/', authenticate, listNotes);

export default router;
