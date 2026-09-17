import React, { useEffect, useRef, useState } from 'react';
import { usDate } from '../format';
import { useParams, useSearchParams } from 'react-router-dom';
import { Box, Button, CircularProgress, Typography, Alert } from '@mui/material';
import { Print as PrintIcon } from '@mui/icons-material';
import { invoiceService, InvoiceDetail, InvoiceLine } from '../services/invoiceService';
import { settingsService, CompanySettings } from '../services/settingsService';
import Letterhead from './Letterhead';

/**
 * The statement the office mails (BIL-08).
 *
 * There is no PDF generator in this stack, and there will not be one: the
 * browser's own print dialog *is* the PDF generator. What this component owns is
 * the document — the number, the mailing block, the lines, the payments-and-
 * adjustments ledger that draws the balance down to what is truly owed, and the
 * company's own terms.
 *
 * A corrected bill prints as ONE reconciled paper (BIL-05 × BIL-08): it bills
 * the original's lines and total, then the ledger shows each correction as its
 * own line — naming the document number it was filed under — and each receipt,
 * running the balance to zero. Printing the header alone would demand money the
 * customer does not owe; printing the credit alone is a negative page headed
 * like an invoice. Neither is sendable; this is.
 *
 * The margins are ours, not the browser's. `@page { margin: 0 }` plus the
 * document's own padding does two things at once: it puts predictable margins on
 * an 8.5×11 sheet regardless of what the print dialog is set to (the office
 * cannot adjust that setting), and it removes the URL / title / page numbers the
 * browser prints into the page-margin box, because with a zero margin there is no
 * margin box left to print them into.
 */

const money = (n: string | number | null) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

// A rate stored as 0.015 reads on paper as "1.5%", trailing zeros trimmed — the
// customer should never see "1.500%".
const rateToPct = (rate: string | number | null | undefined): string => {
  const n = Number(rate);
  return Number.isFinite(n) ? String(Math.round(n * 10000) / 100) : '';
};

// One itemized row of the bill. Shared by the line table only; the corrections and
// receipts live in the ledger below them, not among the charges.
const LineRow: React.FC<{ l: InvoiceLine }> = ({ l }) => (
  <tr>
    <td style={{ padding: '6px 4px' }}>{l.description || '—'}</td>
    <td style={{ padding: '6px 4px', fontSize: 12, color: '#555' }}>
      {l.legacy_product_code || (l.service_event_id ? `event ${l.service_event_id}` : '—')}
    </td>
    <td style={{ padding: '6px 4px', textAlign: 'right' }}>{l.quantity}</td>
    <td style={{ padding: '6px 4px', textAlign: 'right' }}>{money(l.unit_price)}</td>
    <td style={{ padding: '6px 4px', textAlign: 'right' }}>{money(l.amount)}</td>
  </tr>
);

const PrintInvoicePage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const [doc, setDoc] = useState<InvoiceDetail | null>(null);
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printedOnce = useRef(false);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!id || !/^\d+$/.test(id)) { setError('That is not an invoice number.'); return; }
      try {
        const [d, s] = await Promise.all([invoiceService.get(Number(id)), settingsService.get()]);
        if (!live) return;
        setDoc(d); setSettings(s);
        if (params.get('auto') === '1' && !printedOnce.current) {
          printedOnce.current = true;
          setTimeout(() => window.print(), 250);
        }
      } catch (e) {
        if (live) setError((e as Error)?.message || 'Could not load the invoice');
      }
    })();
    return () => { live = false; };
  }, [id, params]);

  // A bill (kind invoice) always prints the reconciled statement; a correction
  // printed on its own (no ?statement) stays the record as filed — the "this is
  // an adjustment" document. ?statement=1 forces the reconciled bill even when the
  // page was opened from the credit, which is how the office sends it.
  const st = doc?.statement;
  const consolidated = params.get('statement') === '1';
  const asStatement = !!st && (doc!.kind === 'invoice' || consolidated);

  const docKind = asStatement ? 'invoice' : (doc?.kind ?? 'invoice');
  const docNumber = asStatement ? st!.display_number : (doc?.legacy_invoice_no ?? `#${doc?.id}`);
  const lineRows = asStatement ? st!.lines : (doc?.lines ?? []);
  const shownSub = asStatement ? st!.subtotal : (doc?.subtotal ?? '0');
  const shownTax = asStatement ? st!.tax_amount : (doc?.tax_amount ?? '0');
  const shownTot = asStatement ? st!.total : (doc?.total ?? '0');
  const shownPaid = asStatement ? st!.amount_paid : (doc?.amount_paid ?? '0');
  const shownBal = asStatement ? st!.balance_due
    : String((Number(doc?.total ?? 0) - Number(doc?.amount_paid ?? 0)).toFixed(2));
  const balanceNum = Number(shownBal);

  const termsSentence = (): string | null => {
    if (!doc) return null;
    const days = settings?.payment_term_days;
    const late = rateToPct(settings?.late_fee_rate_monthly);
    const hasLate = late != null && Number(late) > 0;
    const lateClause = hasLate
      ? `, or a fee of ${late}% per month will be charged on past-due invoices.`
      : '.';
    return days === 0
      ? `Payment is due on receipt${lateClause}`
      : `Payments are due ${days} days from the invoice date of ${usDate(doc.invoice_date)}${lateClause}`;
  };

  let rawRunning = Number(doc?.total ?? 0);

  return (
    <Box className="print-root" sx={{ maxWidth: 720, mx: 'auto', py: 4 }}>
      <style>{`
        /* The office mails this on 8.5×11 and cannot adjust the print dialog, so
           the margins are declared here. margin:0 removes the browser's own page
           box — which is where it draws the URL, the title and the page numbers —
           and the document's padding (below) puts the printable inset back. */
        @page { size: letter; margin: 0; }
        @media print {
          html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
          .MuiAppBar-root, .MuiDrawer-root, .MuiBackdrop-root, nav, .no-print { display: none !important; }
          main { margin: 0 !important; padding: 0 !important; width: 100% !important; max-width: none !important; }
          .print-root { max-width: none !important; width: 100% !important; margin: 0 !important; padding: 0.6in 0.7in !important; }
          .print-paper { border: none !important; padding: 0 !important; }
          tr { break-inside: avoid; page-break-inside: avoid; }
          thead { display: table-header-group; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          a { text-decoration: none; color: inherit; }
        }
      `}</style>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {!doc && !error && <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>}

      {doc && (
        <>
          <Box className="no-print" sx={{ mb: 2, display: 'flex', gap: 1 }}>
            <Button variant="contained" startIcon={<PrintIcon />}
              onClick={() => window.print()}>Print</Button>
          </Box>

          <Box className="print-paper" sx={{
            bgcolor: 'background.paper', p: 4, border: '1px solid', borderColor: 'divider',
            '@media print': { border: 'none', p: 0 },
          }}>
            <Letterhead settings={settings} />
            <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
              Pump-out &amp; service records — {docKind}{' '}{docNumber}
            </Typography>

            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 4 }}>
              <Box>
                <Typography variant="overline" color="text.secondary">Billed to</Typography>
                <Typography variant="body1" sx={{ fontWeight: 600 }}>{doc.payer_name}</Typography>
                {doc.mailing_address && <Typography variant="body2">{doc.mailing_address}</Typography>}
                <Typography variant="body2">
                  {[doc.mailing_city, doc.mailing_state, doc.mailing_zip].filter(Boolean).join(', ')}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="overline" color="text.secondary">Issued</Typography>
                <Typography variant="body2">{usDate(doc.invoice_date)}</Typography>
                <Typography variant="overline" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                  Status
                </Typography>
                <Typography variant="body2" sx={{ textTransform: 'uppercase' }}>{doc.status}</Typography>
              </Box>
            </Box>

            {doc.site_address && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Service site: {doc.site_address}{doc.site_city ? `, ${doc.site_city}` : ''}
              </Typography>
            )}

            {!asStatement && docKind !== 'invoice' && (
              <Typography variant="body1" sx={{ fontWeight: 700, mb: 2, color: 'warning.dark' }}>
                This is a {doc.kind}, not an invoice — {doc.adjusts_invoice_id
                  ? `it corrects invoice #${doc.adjusts_invoice_id}.` : 'it carries a credit.'}
              </Typography>
            )}

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Description', 'Reference', 'Qty', 'Unit', 'Amount'].map((h, i) => (
                    <th key={h} style={{
                      textAlign: i > 1 ? 'right' : 'left', borderBottom: '2px solid #000',
                      padding: '6px 4px', fontSize: 12,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lineRows.map((l) => <LineRow key={l.id} l={l} />)}
                {!lineRows.length && (
                  <tr><td colSpan={5} style={{ padding: '6px 4px', color: '#777' }}>
                    No itemized lines were carried for this document.
                  </td></tr>
                )}
              </tbody>
            </table>

            <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.25 }}>
              <Typography variant="body2">Subtotal {money(shownSub)}</Typography>
              <Typography variant="body2">Tax {money(shownTax)}</Typography>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>Total {money(shownTot)}</Typography>
              <Typography variant="body2">Paid {money(shownPaid)}</Typography>
              <Typography variant="h6" color={balanceNum > 0 ? 'error.dark' : 'success.dark'}>
                Balance due {money(shownBal)}
              </Typography>
            </Box>

            {asStatement && (st!.ledger.length > 0 || Number(shownTot) > 0) && (
              <Box sx={{ mt: 4 }}>
                <Typography variant="overline" color="text.secondary">
                  Payments and adjustments
                </Typography>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    <tr>
                      <td style={{ padding: '3px 4px', fontSize: 12, color: '#555' }}>Invoice total</td>
                      <td />
                      <td style={{ padding: '3px 4px', textAlign: 'right' }}>{money(shownTot)}</td>
                      <td style={{ padding: '3px 4px', textAlign: 'right', color: '#555' }}>
                        balance {money(shownTot)}
                      </td>
                    </tr>
                    {st!.ledger.map((e, i) => {
                      rawRunning = Number(e.running);
                      return (
                        <tr key={`${e.kind}-${e.id}`}>
                          <td style={{ padding: '3px 4px' }}>
                            {e.kind === 'payment'
                              ? e.label
                              : `Adjustment — ${e.label}`}
                          </td>
                          <td style={{ padding: '3px 4px', fontSize: 12, color: '#555' }}>
                            {usDate(e.date) || '—'}{e.ref ? ` · ${e.ref}` : ''}
                          </td>
                          <td style={{ padding: '3px 4px', textAlign: 'right' }}>
                            {money(e.amount)}
                          </td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', color: '#555' }}>
                            balance {money(e.running)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Box>
            )}

            {!asStatement && (doc.payments?.length ?? 0) > 0 && (
              <Box sx={{ mt: 4 }}>
                <Typography variant="overline" color="text.secondary">Payment history</Typography>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {doc.payments.map((p) => {
                      const before = rawRunning;
                      rawRunning -= Number(p.amount);
                      return (
                        <tr key={p.id}>
                          <td style={{ padding: '3px 4px', width: 96 }}>{usDate(p.paid_at) || '—'}</td>
                          <td style={{ padding: '3px 4px' }}>
                            {p.method}{p.reference ? ` #${p.reference}` : ''}
                            {' · '}{p.received_by ?? 'legacy import'}
                          </td>
                          <td style={{ padding: '3px 4px', textAlign: 'right' }}>{money(p.amount)}</td>
                          <td style={{ padding: '3px 4px', textAlign: 'right', color: '#555' }}>
                            balance {money(before - Number(p.amount))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Box>
            )}

            {asStatement && termsSentence() && (
              <Typography variant="body2" sx={{ mt: 4, pt: 2, borderTop: '1px solid #ddd' }}>
                {termsSentence()}
              </Typography>
            )}

            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 4 }}>
              Questions about this account? Call the office and read them the invoice
              number above — every payment and correction we have received is recorded against it.
            </Typography>
          </Box>
        </>
      )}
    </Box>
  );
};

export default PrintInvoicePage;
