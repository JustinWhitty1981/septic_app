import React, { useEffect, useRef, useState } from 'react';
import { usDate } from '../format';
import { useParams, useSearchParams } from 'react-router-dom';
import { Box, Button, CircularProgress, Typography, Alert } from '@mui/material';
import { Print as PrintIcon } from '@mui/icons-material';
import { bidService, BidDetail } from '../services/bidService';
import { settingsService, CompanySettings } from '../services/settingsService';
import Letterhead from './Letterhead';

/**
 * The paper the customer signs (BIL-15).
 *
 * Same argument as the statement: no PDF library stands between the company's
 * name and a signed quote; the browser's print dialog renders the text and the
 * drawer falls away for the printer. What belongs to this component is the
 * document — number, date, mailing block, lines with their units, the tax
 * line, and the total — and one refusal: a declined bid has no business being
 * printed. The approval this paper exists to collect cannot be gathered
 * retroactively for a decision already made against us.
 *
 * The money is the server's formatted, never recomputed here: what prints is
 * what the endpoint would bill, and a paper that rounds differently than the
 * database is how bids get argued about.
 *
 * The page-level sheet is the invoice's, verbatim (the 09/06 lesson, BIL-08's
 * as-built, re-earned on this page after the office found bids printing with
 * browser headers, the 240px nav gutter reserved, and washed-out grays): the
 * `@page` zeroing that removes the URL and page numbers, the chrome gone
 * including the `nav` gutter, physical margins on the document, no line torn
 * across pages, the table header repeating, exact grays. Two print sheets that
 * drift is how one paper prints well and its sibling never did.
 *
 * The identity is the settings row's too (0037): the letterhead that prints
 * here is the same one the statement carries, so the signed quote and the
 * later bill cannot disagree about who wrote them.
 */

const money = (n: string | number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

const pct = (r: string | null | undefined) =>
  r == null ? '—' : `${(Number(r) * 100).toLocaleString(undefined,
    { maximumFractionDigits: 3 })}%`;

const BidPrintPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const [doc, setDoc] = useState<BidDetail | null>(null);
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printedOnce = useRef(false);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!id || !/^\d+$/.test(id)) { setError('That is not a bid number.'); return; }
      try {
        // One request for the document, one for the letterhead it prints under
        // — the same pairing the statement makes (BIL-08).
        const [b, s] = await Promise.all(
          [bidService.bid(Number(id)), settingsService.get()],
        );
        if (!live) return;
        setDoc(b.data); setSettings(s);
        if (params.get('auto') === '1' && b.data.status !== 'declined'
            && !printedOnce.current) {
          printedOnce.current = true;
          setTimeout(() => window.print(), 250);
        }
      } catch (e) {
        if (live) setError((e as Error)?.message || 'Could not load the bid');
      }
    })();
    return () => { live = false; };
  }, [id, params]);

  if (error) return <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>;
  if (!doc) return <CircularProgress sx={{ m: 4 }} />;

  if (doc.status === 'declined') {
    return (
      <Alert severity="info" sx={{ m: 4 }}>
        Bid #{doc.id} was declined — declined bids are not printed.
      </Alert>
    );
  }

  const mailing = [doc.mailing_address,
    [doc.mailing_city, doc.mailing_state, doc.mailing_zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');

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

      <Box className="no-print" sx={{ mb: 2, display: 'flex', gap: 1 }}>
        <Button variant="contained" startIcon={<PrintIcon />}
          onClick={() => window.print()}>Print</Button>
      </Box>

      <Box className="print-paper" sx={{
        bgcolor: 'background.paper', p: 4, border: '1px solid', borderColor: 'divider',
        '@media print': { border: 'none', p: 0 },
      }}>
        <Letterhead settings={settings} />
        <Typography variant="h6" sx={{ mt: 0.5, mb: 3 }}>
          Bid #{doc.id} — {usDate(doc.bid_date)}
        </Typography>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 4 }}>
          <Box>
            <Typography variant="overline" color="text.secondary">Prepared for</Typography>
            <Typography variant="body1" sx={{ fontWeight: 600 }}>{doc.payer_name}</Typography>
            {mailing && <Typography variant="body2">{mailing}</Typography>}
            {doc.site_address && (
              <Typography variant="body2" color="text.secondary">
                Work site: {[doc.site_address, doc.site_city, doc.site_state, doc.site_zip]
                  .filter(Boolean).join(', ')}
              </Typography>
            )}
          </Box>
          <Box sx={{ textAlign: 'right' }}>
            <Typography variant="overline" color="text.secondary">Bid date</Typography>
            <Typography variant="body2">{usDate(doc.bid_date)}</Typography>
          </Box>
        </Box>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Description', 'Price', 'Qty', 'Total'].map((h, i) => (
                <th key={h} style={{
                  textAlign: i > 0 ? 'right' : 'left', borderBottom: '2px solid #000',
                  padding: '6px 4px', fontSize: 12,
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l) => (
              <tr key={l.id}>
                <td style={{ padding: '6px 4px' }}>
                  {l.description}{' '}
                  <span style={{ fontSize: 12, color: '#555' }}>({l.unit})</span>
                </td>
                <td style={{ padding: '6px 4px', textAlign: 'right' }}>{money(l.unit_price)}</td>
                <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                  {l.quantity.replace(/\.?0+$/, '')}
                </td>
                <td style={{ padding: '6px 4px', textAlign: 'right' }}>{money(l.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <Box sx={{ mt: 2, textAlign: 'right' }}>
          <Typography variant="body2">Subtotal {money(doc.subtotal)}</Typography>
          <Typography variant="body2">
            Sales tax {pct(doc.eff_tax_rate)}{doc.tax_estimated ? ' (estimated)' : ''}:
            {' '}{money(doc.tax_amount)}
          </Typography>
          <Typography variant="h6">Total {money(doc.total)}</Typography>
        </Box>

        {doc.notes && (
          <Box sx={{ mt: 3 }}>
            <Typography variant="subtitle2">Notes</Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{doc.notes}</Typography>
          </Box>
        )}

        <Box sx={{ mt: 5, borderTop: '1px solid #0004', pt: 2 }}>
          <Typography variant="body2">
            Approved: ______________________________  Date: ______________
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }} display="block">
            {doc.status === 'draft'
              ? 'Tax shown is estimated at the current rate; the final figure is fixed when this bid is approved.'
              : 'Prices and tax shown were fixed at approval.'}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
};

export default BidPrintPage;
