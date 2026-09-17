import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Button, Chip, Collapse, IconButton, Stack, TextField, Typography,
} from '@mui/material';
import {
  ExpandMore as ExpandIcon, ExpandLess as CollapseIcon, PhotoCamera, NoteAlt,
} from '@mui/icons-material';
import { noteService, uploadPhoto, messageOfCapture, NoteRow } from '../services/captureService';

/**
 * The field-capture half of a stop card: notes and photos (DRV-14's "the
 * device owns what it saw").
 *
 * It lives beside `StopActions`, not inside it, because they answer different
 * questions and have opposite failure modes. `StopActions` is the status
 * machine — one queueable JSON write, and the machine must not be confused.
 * This panel appends observations: notes are append-only (two drivers, two
 * notes) and photos are content-addressed (DRV-18's sha256 dedup makes a
 * double-send harmless), so neither can corrupt a record by accident and
 * neither queues.
 *
 * The `client_uuid` on a note is minted once, when Send is pressed, and reused
 * if that same note is retried after a failure — the DRV-12 rule, for the
 * same reason: a retry must re-send the same identity or the server cannot
 * tell a retry from a second, identical note.
 */

interface Props {
  stopId: number;
  propertyId: number;
}

const uuid = (): string =>
  ('crypto' in globalThis && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID()
    : `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });

const CapturePanel: React.FC<Props> = ({ stopId, propertyId }) => {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** One uuid per unsent note, reused across retries of that note. */
  const pendingUuid = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      setNotes(await noteService.list({ route_stop_id: stopId }));
    } catch {
      setNotes([]);
    }
  }, [stopId]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const sendNote = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setFailed(null);
    if (!pendingUuid.current) pendingUuid.current = uuid();
    try {
      await noteService.create({
        body, route_stop_id: stopId, property_id: propertyId,
        client_uuid: pendingUuid.current!,
      });
      pendingUuid.current = null;
      setText('');
      await load();
    } catch (e) {
      setFailed(messageOfCapture(e)); // keep text + uuid: the retry is the same note
    } finally {
      setBusy(false);
    }
  };

  const takePhoto = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFailed(null);
    try {
      const res = await uploadPhoto(file, {
        route_stop_id: stopId, property_id: propertyId,
      });
      setNote(res.deduplicated
        ? `Photo matched one already on file (${res.sha256.slice(0, 8)}…)`
        : `Photo saved (${res.width}×${res.height})`);
    } catch (e) {
      setFailed(messageOfCapture(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <Box sx={{ mt: 1.5 }}>
      <Button
        size="small" onClick={() => setOpen(!open)} aria-label="notes and photos"
        startIcon={open ? <CollapseIcon /> : <ExpandIcon />}
      >
        Notes & photos{notes.length ? ` · ${notes.length}` : ''}
      </Button>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 1 }}>
          {notes.length > 0 && (
            <Box sx={{ mb: 1 }}>
              {notes.map((n) => (
                <Typography key={n.id} variant="body2"
                  sx={{ whiteSpace: 'pre-wrap', borderBottom: '1px solid', borderColor: 'divider', py: 0.5 }}>
                  {n.body}
                  <Typography variant="caption" color="text.secondary" display="block">
                    {new Date(n.client_created_at).toLocaleString()}
                  </Typography>
                </Typography>
              ))}
            </Box>
          )}
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <TextField
              size="small" fullWidth multiline maxRows={3} value={text}
              inputProps={{ placeholder: 'What did you see?', 'aria-label': 'new note' }}
              onChange={(e) => setText(e.target.value)}
            />
            <Button variant="outlined" startIcon={<NoteAlt />} onClick={sendNote}
              disabled={busy || !text.trim()}>
              Send
            </Button>
            <IconButton aria-label="take photo" disabled={busy}
              onClick={() => fileInput.current?.click()}>
              <PhotoCamera />
            </IconButton>
            {/* capture=environment is a hint the browser may honour with the
                rear camera — a hint, not a promise; a desktop picks a file. */}
            <input
              ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp"
              capture="environment" hidden
              onChange={(e) => void takePhoto(e.target.files?.[0])}
            />
          </Stack>
          {note && <Chip size="small" color="success" label={note} sx={{ mt: 1 }} />}
          {failed && (
            <Typography variant="caption" color="error" display="block" sx={{ mt: 1 }}>
              {failed}
            </Typography>
          )}
        </Box>
      </Collapse>
    </Box>
  );
};

export default CapturePanel;
