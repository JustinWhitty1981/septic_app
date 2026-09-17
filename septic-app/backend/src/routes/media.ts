import { Router } from 'express';
import express from 'express';
import { authenticate } from '../middleware/auth';
import { uploadMedia, getMedia, getMediaRaw } from '../controllers/media.controller';

const router = Router();

/**
 * Photos. Any authenticated role — the camera is on the truck, not in the
 * office — so this router is deliberately absent from the OFFICE list in
 * office-gate.test.ts. What limits a photo is not the role but the pipeline:
 * the server re-encodes everything (DRV-15b/16) and the same bytes land once
 * (DRV-18).
 *
 * The JSON parser is mounted per-route with a 16 MB limit and this router is
 * mounted in server.ts *before* the global parser: the first parser to run
 * owns the request stream, and a 16 MB cap sitting behind a 100 KB one is
 * decoration. Scoping it here is what keeps every other endpoint's 100 KB
 * default (a stolen tablet cannot malloc the box through /api/login).
 */
router.post('/upload', authenticate, express.json({ limit: '16mb' }), uploadMedia);
router.get('/:id', authenticate, getMedia);
router.get('/:id/raw', authenticate, getMediaRaw);

export default router;
