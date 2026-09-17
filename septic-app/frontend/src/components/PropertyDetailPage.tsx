import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { usDate } from '../format';
import {
  Box, Button, Chip, Divider, Paper, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Typography, Alert, Skeleton, Stack,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Autocomplete,
} from '@mui/material';
import {
  ArrowBack, SwapHoriz as ReassignIcon, EditNote as EditIcon, Event as EventIcon,
  NoteAdd as NoteAddIcon,
} from '@mui/icons-material';
import { propertyService, PropertyDetail } from '../services/propertyService';
import { authService } from '../services/authService';
import {
  ownerService, payerService, PayerHit, OwnershipRow,
} from '../services/payerService';
import { routeService, DriverOption } from '../services/routeService';
import {
  ledgerService, messageOf, WasteTypeOption, DisposalSiteOption,
} from '../services/ledgerService';
import { newUuid } from '../offline/registration';

/**
 * One site, as the office and the driver both read it.
 *
 * Three things here exist because the legacy app got them wrong in a specific way, and
 * removing them would quietly undo the rebuild:
 *
 *  - The tank's `raw_text`. '1000+1250' and '2-2000' are what the paper said; the
 *    capacity beside it is what we concluded. Shown together so a wrong conclusion is
 *    still visible to the person who can check it.
 *  - `cert_unresolved`. A pumper certificate the migration could not match is flagged
 *    rather than dropped. A DNR audit cannot be reconstructed from a clean-looking gap.
 *  - The field notes verbatim. 'frank pmp W1814 Fur Farm Rd 9-30-86 $50' is not tidy
 *    and is not to be rewritten — it is the oldest evidence about this site that
 *    survives in the system, and it was written by someone standing there.
 */

const Field: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <Box sx={{ minWidth: 180 }}>
    <Typography variant="caption" color="text.secondary" display="block">
      {label}
    </Typography>
    <Typography variant="body2">{value === null || value === '' ? '—' : value}</Typography>
  </Box>
);

const PropertyDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [row, setRow] = useState<PropertyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    // The route parameter is untrusted text. The server validates it too, but sending
    // 'abc' only to be told 400 wastes a round trip and shows the user a failure that
    // was never a failure.
    const numeric = /^\d+$/.test(id || '') ? Number(id) : null;
    if (!numeric) {
      setError('That is not a site number.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await propertyService.detail(numeric);
      setRow(res.data);
    } catch (e: any) {
      setError(e?.message || 'Could not load this site');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const isOffice = authService.hasRole(['admin', 'manager', 'office']);

  // --- editing the site's own facts (SCH-11) --------------------------------
  //
  // The whiteboard version of this screen would put a text box next to
  // "Next due". It does not: that date is arithmetic the ledger does, and the
  // legacy app's hand-editable version of it disagreed with the sum in
  // 32,396 of 45,804 rows (P1). What opens here is the office's half of the
  // row — the address, the notes, the interval — and the server keeps its
  // half: a body that names a ledger-owned column comes back 400 by name.
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = () => {
    if (!row) return;
    setEditForm({
      payer_label: row.payer_label ?? '',
      site_address: row.site_address ?? '',
      site_city: row.site_city ?? '',
      site_state: row.site_state ?? '',
      site_zip: row.site_zip ?? '',
      permit_number: row.permit_number ?? '',
      legacy_cust_number: row.legacy_cust_number != null ? String(row.legacy_cust_number) : '',
      service_interval_days: String(row.service_interval_days),
      status: row.status,
      reminder_opt_out: row.reminder_opt_out ? 'true' : 'false',
      tank_location_note: row.tank_location_note ?? '',
      jobsite_location_note: row.jobsite_location_note ?? '',
      pump_style_note: row.pump_style_note ?? '',
      chamber_pump_note: row.chamber_pump_note ?? '',
      system_condition_note: row.system_condition_note ?? '',
    });
    setEditError(null);
    setEditOpen(true);
  };

  const submitEdit = async () => {
    if (propertyId === null) return;
    setEditBusy(true);
    setEditError(null);
    const text = (k: string) => (editForm[k] ?? '').trim();
    try {
      await propertyService.update(propertyId, {
        payer_label: text('payer_label') || null,
        site_address: text('site_address') || null,
        site_city: text('site_city') || null,
        site_state: text('site_state') || null,
        site_zip: text('site_zip') || null,
        permit_number: text('permit_number') || null,
        // Empty means "leave it": a blank box is not a licence to erase the
        // number crews radio, but the server can also clear it with an
        // explicit null — the client just does not offer that by accident.
        legacy_cust_number: text('legacy_cust_number') ? Number(text('legacy_cust_number')) : undefined,
        service_interval_days: Number(text('service_interval_days')) || undefined,
        status: (editForm.status || 'active') as 'active' | 'inactive' | 'sealed' | 'unknown',
        reminder_opt_out: editForm.reminder_opt_out === 'true',
        tank_location_note: text('tank_location_note') || null,
        jobsite_location_note: text('jobsite_location_note') || null,
        pump_style_note: text('pump_style_note') || null,
        chamber_pump_note: text('chamber_pump_note') || null,
        system_condition_note: text('system_condition_note') || null,
      });
      // Re-read, never `setRow(response)`: the PATCH answers with the row, and
      // this page renders the assembled detail (tanks, owners, events). The
      // first cut of this handler trusted the row to carry the detail and the
      // next render died on `row.tanks.length` — a 200 followed by a crash is
      // the worst failure mode a save can have.
      await load();
      setEditOpen(false);
    } catch (e) {
      setEditError(messageOf(e));
    } finally {
      setEditBusy(false);
    }
  };

  // --- ownership (SCH-06) -------------------------------------------------
  const [history, setHistory] = useState<OwnershipRow[]>([]);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [payerQuery, setPayerQuery] = useState('');
  const [payerHits, setPayerHits] = useState<PayerHit[]>([]);
  const [payerPicked, setPayerPicked] = useState<PayerHit | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  // Adding a biller (SCH-12) lives in this dialog as a second view, not a
  // dialog over a dialog: it is reached only when the search has genuinely
  // found nobody, and its result must be selectable the instant it exists.
  // The line it defends: typing into search finds people; this form — an
  // explicit button behind it — creates one.
  const [picker, setPicker] = useState<'search' | 'create'>('search');
  const [billerForm, setBillerForm] = useState({
    org_name: '', first_name: '', last_name: '', mailing_address: '',
    mailing_city: '', mailing_state: '', mailing_zip: '', phone: '',
  });
  const [billerBusy, setBillerBusy] = useState(false);

  const openOwnerDialog = () => {
    setAssignError(null);
    setPayerPicked(null);
    setPayerQuery('');
    setPayerHits([]);
    setPicker('search');
    setReassignOpen(true);
  };

  // --- put this site on a driver's day (SCH-13) ------------------------------
  //
  // The clerk standing on a site record is thinking "this one, Tuesday, Marco".
  // The composer makes them find the day first; this dialog starts from where
  // they already are. One POST server-side, deliberately: if the site turns out
  // to be routed to somebody else that day, the refusal comes back with the
  // other route's name and — because it is one transaction — no empty draft
  // for the refused driver. A client that created the day first would leak one
  // per clash, which is how drafts become folklore.
  const [schedOpen, setSchedOpen] = useState(false);
  const [schedDrivers, setSchedDrivers] = useState<DriverOption[]>([]);
  const [schedDriver, setSchedDriver] = useState('');
  const [schedDate, setSchedDate] = useState('');
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedError, setSchedError] = useState<string | null>(null);
  const [schedDone, setSchedDone] = useState<string | null>(null);
  const [schedRoute, setSchedRoute] = useState<{ id: number; date: string } | null>(null);

  const openSchedule = async () => {
    setSchedError(null);
    setSchedDone(null);
    setSchedRoute(null);
    setSchedDriver('');
    // The Day field opens on the server's today, not on the site's stale
    // due date: prefilling 2024 into a schedule dialog in 2026 is exactly
    // what makes the office say the system thinks it is still the migration
    // era. The due date is not hidden — the sentence in the dialog says what
    // it is — but the pen starts on the real day (P10, made visible).
    setSchedDate('');
    setSchedOpen(true);
    try {
      const { meta } = await routeService.forDate(undefined);
      setSchedDate(meta?.business_today ?? row?.next_service_due ?? '');
    } catch {
      setSchedDate(row?.next_service_due ?? '');
    }
    if (!schedDrivers.length) {
      try {
        const { data } = await routeService.drivers();
        setSchedDrivers(data);
      } catch (e) {
        setSchedError(messageOf(e));
      }
    }
  };

  const submitSchedule = async () => {
    if (!row || !schedDriver || !schedDate) return;
    setSchedBusy(true);
    setSchedError(null);
    try {
      const { data: res } = await routeService.addStopForDay({
        property_id: row.id, driver_id: Number(schedDriver), route_date: schedDate,
      });
      // The clerk's next thought is "now make it a good day" — the stop landed
      // at the end, and ordering it and publishing happen on the board, not
      // here. Carry the route id the server just minted so the confirmation is
      // a door, not a dead end.
      setSchedRoute({ id: res.route_id, date: res.route_date });
      const d = schedDrivers.find((x) => String(x.id) === schedDriver);
      const who = d ? `${d.first_name} ${d.last_name}` : `driver ${schedDriver}`;
      setSchedDone(res.route_created
        ? `${row.site_address || `Site ${row.id}`} is stop ${res.sequence_no} on ${who}'s `
          + `new day, ${usDate(res.route_date)}. It stays a draft until you publish it.`
        : `${row.site_address || `Site ${row.id}`} is stop ${res.sequence_no} on ${who}'s `
          + `day, ${usDate(res.route_date)}.`);
    } catch (e) {
      // The server's sentence already names the next thing the clerk needs:
      // the other driver, the date, the route id, or the unpublish remedy.
      setSchedError(messageOf(e));
    } finally {
      setSchedBusy(false);
    }
  };

  // The route parameter, validated once: the hooks below must not depend on
  // `row` existing, because hooks cannot live after an early return.
  const propertyId = id && /^\d+$/.test(id) ? Number(id) : null;

  const loadHistory = useCallback(async () => {
    if (!isOffice || propertyId === null) return;
    try {
      setHistory(await ownerService.list(propertyId));
    } catch {
      setHistory([]); // history is context here, not the page's subject
    }
  }, [propertyId, isOffice]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const searchPayers = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setPayerHits([]); return; }
    try {
      setPayerHits(await payerService.search(q));
    } catch (e) {
      setAssignError((e as Error)?.message || 'Payer search failed');
    }
  }, []);

  const createBiller = async () => {
    setBillerBusy(true);
    setAssignError(null);
    const t = (k: keyof typeof billerForm) => billerForm[k].trim();
    try {
      const created = await payerService.create({
        org_name: t('org_name') || null,
        first_name: t('first_name') || null,
        last_name: t('last_name') || null,
        mailing_address: t('mailing_address') || null,
        mailing_city: t('mailing_city') || null,
        mailing_state: t('mailing_state') || null,
        mailing_zip: t('mailing_zip') || null,
        phone: t('phone') || null,
      });
      // The created row *is* the pick — re-searching to find what the server
      // just named back could match a same-named household instead (SCH-12
      // tolerates duplicates on purpose).
      setPayerHits((hits) => [created, ...hits]);
      setPayerPicked(created);
      setPayerQuery(created.name ?? '');
      setPicker('search');
    } catch (e) {
      setAssignError(messageOf(e));
    } finally {
      setBillerBusy(false);
    }
  };

  const submitAssign = async () => {
    if (!payerPicked) return;
    setAssignBusy(true);
    setAssignError(null);
    try {
      if (propertyId === null) return;
      await ownerService.assign(propertyId, payerPicked.id);
      setReassignOpen(false);
      setPayerPicked(null);
      setPayerQuery('');
      await Promise.all([loadHistory(), load()]);
    } catch (e) {
      setAssignError(messageOf(e));
    } finally {
      setAssignBusy(false);
    }
  };

  // --- unscheduled service records (DRV-20) -------------------------------
  // The truck finds work the office never routed, and the phone that found
  // it is reading this page. Every role may file — the driver in the
  // driveway most of all — and the client_uuid is minted when the dialog
  // opens, not per attempt, so a retry after a lost response files the
  // pump-out once (DRV-13's rule at this door, and the same secure-context
  // safe mint the offline queue uses: this app is served over http://).
  const [recOpen, setRecOpen] = useState(false);
  const [recForm, setRecForm] = useState({ gallons: '', waste: '', site: '', note: '' });
  const [recUuid, setRecUuid] = useState('');
  const [recBusy, setRecBusy] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [recDone, setRecDone] = useState<string | null>(null);

  const openRecord = async () => {
    setRecForm({ gallons: '', waste: '', site: '', note: '' });
    setRecUuid(newUuid());
    setRecError(null);
    setRecDone(null);
    setRecOpen(true);
    if (!options) {
      try { setOptions(await ledgerService.lookups()); }
      catch (err) { setRecError(messageOf(err)); }
    }
  };

  const submitRecord = async () => {
    if (!row || !recForm.site) return;
    setRecBusy(true);
    setRecError(null);
    try {
      const { event, warnings } = await ledgerService.record({
        property_id: row.id,
        client_uuid: recUuid,
        disposal_site_id: Number(recForm.site),
        gallons_pumped: recForm.gallons ? Number(recForm.gallons) : undefined,
        waste_type_id: recForm.waste ? Number(recForm.waste) : undefined,
        waste_note: recForm.note || undefined,
      });
      const when = usDate((event as { service_date?: string }).service_date) || 'today';
      setRecDone(`Filed for ${when}. It counts toward the county report`
        + (warnings?.length ? ` — ${warnings[0]}` : '.'));
      await load();
    } catch (e) {
      // The server's refusal already names what is missing; this page does
      // not get to paraphrase the ledger.
      setRecError(messageOf(e));
    } finally {
      setRecBusy(false);
    }
  };

  // --- corrections (LED-01) -----------------------------------------------
  // Came in from the due queue? Then closing a schedule confirmation returns
  // to the queue (freshly read — the booked site is off the list by SCH-15),
  // carrying the confirmation text as a banner so the add stays on the wall.
  const location = useLocation();
  const cameFromQueue = (location.state as { from?: string } | null)?.from === 'due-queue';
  const [correctFor, setCorrectFor] = useState<{ id: number; date: string } | null>(null);
  const [options, setOptions] = useState<{
    waste_types: WasteTypeOption[]; disposal_sites: DisposalSiteOption[];
  } | null>(null);
  const [correctForm, setCorrectForm] = useState<Record<string, string>>({});
  const [correctBusy, setCorrectBusy] = useState(false);
  const [correctError, setCorrectError] = useState<string | null>(null);

  const openCorrect = async (e: { id: number; service_date: string }) => {
    setCorrectForm({});
    setCorrectError(null);
    setCorrectFor({ id: e.id, date: e.service_date });
    if (!options) {
      try { setOptions(await ledgerService.lookups()); }
      catch (err) { setCorrectError(messageOf(err)); }
    }
  };

  const submitCorrect = async () => {
    if (!correctFor) return;
    setCorrectBusy(true);
    setCorrectError(null);
    try {
      const changes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(correctForm)) {
        if (k === 'note' || v.trim() === '') continue;
        changes[k] = ['gallons_pumped', 'waste_type_id', 'disposal_site_id',
          'ph_before', 'ph_after', 'duration_minutes'].includes(k)
          ? Number(v) : v;
      }
      if (!Object.keys(changes).length) throw new Error('Nothing to correct — no field was filled in.');
      await ledgerService.correct(String(correctFor.id), changes, (correctForm.note ?? '').trim());
      setCorrectFor(null);
      await load();
    } catch (e) {
      setCorrectError(messageOf(e));
    } finally {
      setCorrectBusy(false);
    }
  };


  if (loading) {
    return (
      <Box>
        <Skeleton width={260} height={44} />
        <Skeleton width="60%" height={24} />
      </Box>
    );
  }

  if (error || !row) {
    return (
      <Box>
        <Alert severity="error" sx={{ mb: 2 }}>
          {error || 'Site not found'}
        </Alert>
        <Button startIcon={<ArrowBack />} onClick={() => navigate('/due-queue')}>
          Back to the queue
        </Button>
      </Box>
    );
  }

  const owner = row.owners[0];

  return (
    <Box>
      <Button startIcon={<ArrowBack />} size="small" onClick={() => navigate('/due-queue')}>
        Due queue
      </Button>

      <Typography variant="h4">
        {row.payer_label || row.site_address || `Site ${row.id}`}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mt: 0.5, mb: 2, flexWrap: 'wrap' }}
        alignItems="center">
        <Chip size="small" label={`cust #${row.legacy_cust_number ?? '—'}`} />
        <Chip size="small" label={row.status} variant="outlined" />
        {row.county_name && <Chip size="small" label={row.county_name} variant="outlined" />}
        {row.county_raw && row.county_raw !== row.county_name && (
          <Chip size="small" variant="outlined" label={`as written: ${row.county_raw}`} />
        )}
        {isOffice && (
          <Button size="small" startIcon={<EditIcon />} aria-label="edit site"
            onClick={openEdit}>
            Edit site
          </Button>
        )}
        {isOffice && (
          <Button size="small" startIcon={<EventIcon />} aria-label="add to schedule"
            onClick={() => { void openSchedule(); }}>
            Add to schedule
          </Button>
        )}
        <Button size="small" startIcon={<NoteAddIcon />} aria-label="record service"
          onClick={() => { void openRecord(); }}>
          Record service
        </Button>
      </Stack>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Stack direction="row" spacing={4} flexWrap="wrap" useFlexGap>
          <Field label="Address" value={row.site_address} />
          <Field
            label="City"
            value={[row.site_city, row.site_state, row.site_zip].filter(Boolean).join(' ')}
          />
          <Field label="System" value={row.system_type_name} />
          <Field label="Permit" value={row.permit_number} />
          <Field label="Last serviced" value={usDate(row.last_service_date)} />
          <Field label="Next due" value={usDate(row.next_service_due)} />
          <Field label="Interval" value={`${row.service_interval_days} days`} />
        </Stack>
      </Paper>

      <Divider sx={{ my: 3 }} orientation="horizontal" textAlign="left">
        <Typography variant="overline" color="text.secondary">Tanks</Typography>
      </Divider>
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>#</TableCell>
              <TableCell>Role</TableCell>
              <TableCell align="right">Capacity</TableCell>
              <TableCell align="center">Filter</TableCell>
              <TableCell>As recorded</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {row.tanks.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography color="text.secondary">No tanks recorded.</Typography>
                </TableCell>
              </TableRow>
            )}
            {row.tanks.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.sequence_no}</TableCell>
                <TableCell>{t.role.replace('_', ' ')}</TableCell>
                <TableCell align="right">
                  {t.capacity_gallons === null ? (
                    <Chip size="small" color="warning" label="not a single value" />
                  ) : (
                    `${t.capacity_gallons.toLocaleString()} gal`
                  )}
                </TableCell>
                <TableCell align="center">{t.has_filter ? 'yes' : 'no'}</TableCell>
                <TableCell>
                  <code>{t.raw_text}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Divider sx={{ my: 3 }} textAlign="left">
        <Typography variant="overline" color="text.secondary">Billed to</Typography>
      </Divider>
      {owner ? (
        <Paper sx={{ p: 2 }}>
          <Stack direction="row" spacing={4} flexWrap="wrap" useFlexGap alignItems="center">
            <Field label="Name on file" value={owner.payer_name} />
            <Field label="Phone" value={owner.phone} />
            <Field label="Since" value={owner.ownership_start} />
            <Field
              label="Record"
              value={owner.source === 'legacy' ? 'imported, never confirmed' : owner.source}
            />
            {isOffice && (
              <Button
                size="small" startIcon={<ReassignIcon />} aria-label="reassign owner"
                onClick={openOwnerDialog}
              >
                Reassign
              </Button>
            )}
          </Stack>
        </Paper>
      ) : (
        <Stack spacing={1}>
          <Alert severity="warning">
            No open ownership row. This site has nobody to bill until one is recorded.
          </Alert>
          {/* The empty state is a door, not a dead end. SCH-06's endpoint has
              always accepted a site with no current row — close-nothing,
              open-one — but until the "add a site" flow existed every site in
              the database had an owner, so no screen ever offered the first
              assignment. A site the office just created is the first case
              where "record who pays" is the *only* action available, and the
              warning that only diagnoses the gap would strand the new row. */}
          {isOffice && (
            <Button
              size="small" startIcon={<ReassignIcon />} aria-label="record owner"
              onClick={openOwnerDialog}
              sx={{ alignSelf: 'flex-start' }}
            >
              Record owner
            </Button>
          )}
        </Stack>
      )}
      {history.length > 1 && (
        <TableContainer component={Paper} sx={{ mt: 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Owner</TableCell>
                <TableCell>From</TableCell>
                <TableCell>To</TableCell>
                <TableCell>Record</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {history.map((o) => (
                <TableRow key={o.id} hover>
                  <TableCell>{o.payer_name || `payer #${o.payer_id}`}</TableCell>
                  <TableCell>{usDate(o.ownership_start)}</TableCell>
                  <TableCell>
                    {o.ownership_end ? usDate(o.ownership_end) : 'current'}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" variant="outlined"
                      label={o.source === 'legacy' ? 'imported' : o.source} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Divider sx={{ my: 3 }} textAlign="left">
        <Typography variant="overline" color="text.secondary">Last ten pump-outs</Typography>
      </Divider>
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Date</TableCell>
              <TableCell>Pumper</TableCell>
              <TableCell align="right">Gallons</TableCell>
              <TableCell>Disposal site</TableCell>
              <TableCell>Origin</TableCell>
              {isOffice && <TableCell />}
            </TableRow>
          </TableHead>
          <TableBody>
            {row.recent_events.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography color="text.secondary">
                    No service events. This site has never been pumped on record, so it has
                    no due date.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {row.recent_events.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{usDate(e.service_date)}</TableCell>
                <TableCell>
                  {e.pumper || (e.cert_unresolved ? (
                    <Chip size="small" color="warning" label="certificate unmatched" />
                  ) : (
                    '—'
                  ))}
                </TableCell>
                <TableCell align="right">{e.gallons_pumped ?? '—'}</TableCell>
                <TableCell>{e.disposal_site || '—'}</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={e.source === 'legacy_import' ? 'imported' : e.source}
                  />
                </TableCell>
                {isOffice && (
                  <TableCell align="right">
                    <Button size="small" onClick={() => openCorrect(e)}>Correct</Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {(row.tank_location_note || row.jobsite_location_note || row.legacy_memo) && (
        <>
          <Divider sx={{ my: 3 }} textAlign="left">
            <Typography variant="overline" color="text.secondary">
              Field notes, as written
            </Typography>
          </Divider>
          <Paper sx={{ p: 2 }}>
            {row.tank_location_note && (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
                <strong>Tank location:</strong> {row.tank_location_note}
              </Typography>
            )}
            {row.jobsite_location_note && (
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
                <strong>Jobsite:</strong> {row.jobsite_location_note}
              </Typography>
            )}
            {row.legacy_memo && (
              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
                <strong>Legacy memo:</strong> {row.legacy_memo}
              </Typography>
            )}
          </Paper>
        </>
      )}
      <Dialog open={editOpen} onClose={() => !editBusy && setEditOpen(false)}
        maxWidth="sm" fullWidth>
        <DialogTitle>Edit the site</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            What is filed here edits today&rsquo;s facts. The service history,
            the last-service date and the generated due date are not editable —
            they follow the ledger, and a typed-over due date is how the legacy
            app ended up disagreeing with its own arithmetic 32,396 times.
          </Typography>
          <Stack spacing={1}>
            <TextField label="Name on the bill (payer label)" size="small"
              value={editForm.payer_label ?? ''}
              onChange={(e) => setEditForm((f) => ({ ...f, payer_label: e.target.value }))} />
            <TextField label="Site address" size="small" required
              value={editForm.site_address ?? ''}
              onChange={(e) => setEditForm((f) => ({ ...f, site_address: e.target.value }))} />
            <Stack direction="row" spacing={1}>
              <TextField label="City" size="small" value={editForm.site_city ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, site_city: e.target.value }))} />
              <TextField label="State" size="small" inputProps={{ maxLength: 2 }}
                value={editForm.site_state ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, site_state: e.target.value }))} />
              <TextField label="ZIP" size="small" inputProps={{ maxLength: 10 }}
                value={editForm.site_zip ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, site_zip: e.target.value }))} />
            </Stack>
            <Stack direction="row" spacing={1}>
              <TextField label="Legacy customer number" size="small"
                value={editForm.legacy_cust_number ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, legacy_cust_number: e.target.value }))} />
              <TextField label="Permit number" size="small" value={editForm.permit_number ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, permit_number: e.target.value }))} />
            </Stack>
            <Stack direction="row" spacing={1}>
              <TextField label="Service interval (days)" size="small"
                value={editForm.service_interval_days ?? ''}
                helperText="the rule; the due date is the arithmetic"
                onChange={(e) => setEditForm((f) => ({ ...f, service_interval_days: e.target.value }))} />
              <TextField label="Status" size="small" select SelectProps={{ native: true }}
                value={editForm.status ?? 'active'}
                helperText="sealed/inactive retires it from the queue; there is no delete"
                onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}>
                <option value="active">active</option>
                <option value="inactive">inactive</option>
                <option value="sealed">sealed</option>
                <option value="unknown">unknown</option>
              </TextField>
              <TextField label="Reminders" size="small" select SelectProps={{ native: true }}
                value={editForm.reminder_opt_out ?? 'false'}
                onChange={(e) => setEditForm((f) => ({ ...f, reminder_opt_out: e.target.value }))}>
                <option value="false">opted in</option>
                <option value="true">opted out</option>
              </TextField>
            </Stack>
            {(['tank_location_note', 'jobsite_location_note', 'pump_style_note',
               'chamber_pump_note', 'system_condition_note'] as const).map((k) => (
              <TextField key={k} size="small" multiline minRows={1}
                label={k.replace(/_/g, ' ')}
                value={editForm[k] ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, [k]: e.target.value }))} />
            ))}
          </Stack>
          {editError && <Alert severity="error" sx={{ mt: 1 }}>{editError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} disabled={editBusy}>Cancel</Button>
          <Button variant="contained" onClick={submitEdit}
            disabled={editBusy || !(editForm.site_address ?? '').trim()}>
            Save changes
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={reassignOpen} onClose={() => !assignBusy && setReassignOpen(false)}
        maxWidth="sm" fullWidth>
        <DialogTitle>{owner ? 'Reassign ownership' : 'Record owner'}</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {owner
              ? 'This records an event, not an edit: the current owner\u2019s record closes at today and the new one opens at the same date. The history below stays exactly as it was.'
              : 'This records an event, not an edit: it opens the ownership row that billing hangs on, dated today. Nothing else on the site changes.'}
          </Typography>
          {picker === 'search' ? (
            <Autocomplete
              options={payerHits}
              getOptionLabel={(o) => `${o.name ?? `payer #${o.id}`} — ${o.sites_owned} site${o.sites_owned === 1 ? '' : 's'}`}
              onInputChange={(_, v) => { setPayerQuery(v); void searchPayers(v); }}
              onChange={(_, v) => setPayerPicked(v)}
              inputValue={payerQuery}
              filterOptions={(o) => o}
              // The empty result is a door, not a wall — but the door is a
              // button, not a keystroke. Search finds people; SCH-12's form
              // creates them, and only this click opens it.
              noOptionsText={payerQuery.trim().length >= 2 ? (
                <Stack alignItems="center" spacing={1} sx={{ py: 1 }}>
                  <Typography variant="body2">
                    No biller named “{payerQuery.trim()}” exists yet.
                  </Typography>
                  <Button size="small" variant="outlined" onClick={() => setPicker('create')}>
                    Add “{payerQuery.trim()}” as a new biller
                  </Button>
                </Stack>
              ) : payerQuery.length < 2 ? 'Type at least two characters' : 'No payers match'}
              renderInput={(params) => (
                // MERGE, never replace, the params' `inputProps`: it is not a
                // free-form extras bag — it is the input element's own prop
                // bundle, and the ref Autocomplete focus()es through lives in
                // it. Overwriting it (as `{ 'aria-label': … }` did) silently
                // drops the ref, and the dialog then dies on null.focus() the
                // moment it opens: an uncaught crash before anything is typed.
                <TextField {...params} label="Search payers"
                  inputProps={{ ...params.inputProps, 'aria-label': 'payer search' }} />
              )}
            />
          ) : (
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                Creating a biller from the search that found nobody
                {payerQuery.trim() ? `: “${payerQuery.trim()}”` : ''}. A biller is
                a mailing address (SCH-07) — fill in what the paperwork says.
              </Typography>
              <TextField label="Organization (optional)" size="small"
                value={billerForm.org_name}
                onChange={(e) => setBillerForm({ ...billerForm, org_name: e.target.value })} />
              <Stack direction="row" spacing={1}>
                <TextField label="First name" size="small" value={billerForm.first_name}
                  onChange={(e) => setBillerForm({ ...billerForm, first_name: e.target.value })} />
                <TextField label="Last name" size="small" value={billerForm.last_name}
                  onChange={(e) => setBillerForm({ ...billerForm, last_name: e.target.value })} />
              </Stack>
              <TextField label="Mailing address" size="small" value={billerForm.mailing_address}
                onChange={(e) => setBillerForm({ ...billerForm, mailing_address: e.target.value })} />
              <Stack direction="row" spacing={1}>
                <TextField label="City" size="small" value={billerForm.mailing_city}
                  onChange={(e) => setBillerForm({ ...billerForm, mailing_city: e.target.value })} />
                <TextField label="State" size="small" inputProps={{ maxLength: 2 }}
                  value={billerForm.mailing_state}
                  onChange={(e) => setBillerForm({ ...billerForm, mailing_state: e.target.value })} />
                <TextField label="ZIP" size="small" inputProps={{ maxLength: 10 }}
                  value={billerForm.mailing_zip}
                  onChange={(e) => setBillerForm({ ...billerForm, mailing_zip: e.target.value })} />
              </Stack>
              <TextField label="Phone (optional)" size="small" value={billerForm.phone}
                helperText="1.6% of legacy billers had one; nothing will text them"
                onChange={(e) => setBillerForm({ ...billerForm, phone: e.target.value })} />
            </Stack>
          )}
          {assignError && <Alert severity="error" sx={{ mt: 1 }}>{assignError}</Alert>}
        </DialogContent>
        <DialogActions>
          {picker === 'search' ? (
            <>
              <Button onClick={() => setReassignOpen(false)} disabled={assignBusy}>Cancel</Button>
              <Button variant="contained" onClick={submitAssign}
                disabled={assignBusy || !payerPicked}>
                Record change
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => { setAssignError(null); setPicker('search'); }}
                disabled={billerBusy}>
                Back to search
              </Button>
              <Button variant="contained" onClick={createBiller}
                disabled={billerBusy
                  || !(billerForm.org_name.trim() || billerForm.first_name.trim()
                       || billerForm.last_name.trim())}>
                Create biller
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={!!correctFor} onClose={() => !correctBusy && setCorrectFor(null)}
        maxWidth="sm" fullWidth>
        <DialogTitle>Correct the {usDate(correctFor?.date)} record</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            The original entry is never edited. What you file here becomes a new
            correcting entry, and the original is marked superseded. Property, date
            and pumper are identity, not measurements, and cannot be corrected.
          </Typography>
          <Stack spacing={1}>
            <TextField label="Gallons pumped" size="small" type="number"
              onChange={(e) => setCorrectForm((f) => ({ ...f, gallons_pumped: e.target.value }))}
              inputProps={{ 'aria-label': 'corrected gallons' }} />
            <TextField select size="small" label="Waste type"
              onChange={(e) => setCorrectForm((f) => ({ ...f, waste_type_id: e.target.value }))}>
              <MenuItem value="">(unchanged)</MenuItem>
              {options?.waste_types.map((w) => (
                <MenuItem key={w.id} value={String(w.id)}>{w.name}</MenuItem>
              ))}
            </TextField>
            <TextField select size="small" label="Disposal site"
              onChange={(e) => setCorrectForm((f) => ({ ...f, disposal_site_id: e.target.value }))}>
              <MenuItem value="">(unchanged)</MenuItem>
              {options?.disposal_sites.map((d) => (
                <MenuItem key={d.id} value={String(d.id)}>{d.name}</MenuItem>
              ))}
            </TextField>
            <TextField label="Disposal method" size="small"
              onChange={(e) => setCorrectForm((f) => ({ ...f, disposal_method: e.target.value }))} />
            <TextField label="Reason this record was wrong" size="small" multiline minRows={2}
              onChange={(e) => setCorrectForm((f) => ({ ...f, note: e.target.value }))}
              inputProps={{ 'aria-label': 'correction reason' }} />
          </Stack>
          {correctError && <Alert severity="error" sx={{ mt: 1 }}>{correctError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCorrectFor(null)} disabled={correctBusy}>Cancel</Button>
          <Button variant="contained" onClick={submitCorrect} disabled={correctBusy}>
            File correction
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={schedOpen} onClose={() => setSchedOpen(false)} maxWidth="xs" fullScreen>
        <DialogTitle>Add to schedule</DialogTitle>
        <DialogContent dividers>
          {schedDone ? (
            <Alert severity="success">{schedDone}</Alert>
          ) : (
            <Stack spacing={2} sx={{ mt: 1, minWidth: 260 }}>
              <Typography variant="body2" color="text.secondary">
                {row?.next_service_due
                  ? `This site was due ${usDate(row.next_service_due)}. `
                  : 'This site has no due date yet. '}
                This site lands at the end of that driver&apos;s day. If the day does not
                exist yet it opens as a draft; if the site is already routed that day, the
                refusal will name the route that has it.
              </Typography>
              <TextField select label="Driver" size="small" value={schedDriver}
                onChange={(e) => setSchedDriver(e.target.value)}
                inputProps={{ 'aria-label': 'schedule driver' }}>
                {schedDrivers.map((d) => (
                  <MenuItem key={d.id} value={String(d.id)}>
                    {d.first_name} {d.last_name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField label="Day" type="date" size="small"
                InputLabelProps={{ shrink: true }} value={schedDate}
                onChange={(e) => setSchedDate(e.target.value)}
                inputProps={{ 'aria-label': 'schedule day' }} />
            </Stack>
          )}
          {schedError && <Alert severity="error" sx={{ mt: 1 }}>{schedError}</Alert>}
        </DialogContent>
        <DialogActions>
          {schedDone && cameFromQueue ? (
            // The round trip the queue asked for: confirm, then be back at
            // the queue with it re-read — no back button, and the banner
            // here keeps the confirmation on screen through the reload.
            <Button onClick={() => navigate('/due-queue',
              { state: { addedNote: schedDone } })}>
              Back to due queue
            </Button>
          ) : (
            <Button onClick={() => setSchedOpen(false)}>
              {schedDone ? 'Close' : 'Cancel'}
            </Button>
          )}
          {schedDone && schedRoute && (
            <Button variant="contained" onClick={() => navigate(
              `/routes?date=${schedRoute.date}&focus=${schedRoute.id}`,
            )}>
              Adjust stops & publish
            </Button>
          )}
          {!schedDone && (
            <Button variant="contained" onClick={submitSchedule}
              disabled={schedBusy || !schedDriver || !/^\d{4}-\d{2}-\d{2}$/.test(schedDate)}>
              Add to schedule
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={recOpen} onClose={() => !recBusy && setRecOpen(false)} maxWidth="xs" fullScreen>
        <DialogTitle>Record service</DialogTitle>
        <DialogContent dividers>
          {recDone ? (
            <Alert severity="success">{recDone}</Alert>
          ) : (
            <Stack spacing={2} sx={{ mt: 1, minWidth: 280 }}>
              <Typography variant="body2" color="text.secondary">
                For work that happened without a route — the date is today&apos;s by the
                server&apos;s clock, and you are the pumper unless your login says
                otherwise. The disposal site is required: the state report is assembled
                by site.
              </Typography>
              <TextField label="Gallons pumped" size="small" value={recForm.gallons}
                onChange={(e) => setRecForm((f) => ({ ...f, gallons: e.target.value }))}
                inputProps={{ 'aria-label': 'record gallons' }} />
              <TextField select label="Waste type" size="small" value={recForm.waste}
                onChange={(e) => setRecForm((f) => ({ ...f, waste: e.target.value }))}
                inputProps={{ 'aria-label': 'record waste type' }}>
                {(options?.waste_types ?? []).map((w) => (
                  <MenuItem key={w.id} value={String(w.id)}>{w.name}</MenuItem>
                ))}
              </TextField>
              <TextField select label="Disposal site" size="small" value={recForm.site}
                onChange={(e) => setRecForm((f) => ({ ...f, site: e.target.value }))}
                inputProps={{ 'aria-label': 'record disposal site' }}>
                {(options?.disposal_sites ?? []).map((d) => (
                  <MenuItem key={d.id} value={String(d.id)}>{d.name}</MenuItem>
                ))}
              </TextField>
              <TextField label="Note (what you saw)" size="small" multiline minRows={2}
                value={recForm.note}
                onChange={(e) => setRecForm((f) => ({ ...f, note: e.target.value }))}
                inputProps={{ 'aria-label': 'record note' }} />
            </Stack>
          )}
          {recError && <Alert severity="error" sx={{ mt: 1 }}>{recError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRecOpen(false)}>
            {recDone ? 'Close' : 'Cancel'}
          </Button>
          {!recDone && (
            <Button variant="contained" onClick={submitRecord}
              disabled={recBusy || !recForm.site}>
              Record service
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default PropertyDetailPage;
