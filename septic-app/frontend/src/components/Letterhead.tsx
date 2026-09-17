import React, { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { settingsService, CompanySettings } from '../services/settingsService';

/**
 * The company's identity on paper (0037), shared by both printed documents.
 *
 * It exists because the invoice and the bid each carried their own hardcoded
 * name — two spellings of the same company, differing by two words — and
 * neither carried an address, a phone, or a logo. A customer
 * comparing a signed bid to a later invoice could not see they were the same
 * company, and paper demanding money with no way to call about it is how
 * BIL-08's arguments start. One component, reading the one settings row: what
 * the office sets once is what every document prints.
 *
 * The logo is fetched rather than linked (see settingsService.getLogoUrl) and
 * a failure to fetch it must never fail the document — a missing image is a
 * plainer letterhead, not a blank page.
 */

/** The name printed when the office has not set one yet; the real identity
 *  lives in the company_settings row (0037), never in this file. */
export const DEFAULT_COMPANY_NAME = 'Septic Service';

/** The contact block in print order: address, email, phone — only what is set. */
export const contactLines = (s: CompanySettings | null): string[] =>
  s ? [s.address, s.email, s.phone].filter((v): v is string => !!v) : [];

const Letterhead: React.FC<{ settings: CompanySettings | null }> = ({ settings }) => {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const logoId = settings?.logo_media_id ?? null;

  useEffect(() => {
    if (logoId == null) { setLogoUrl(null); return; }
    let live = true;
    let url: string | null = null;
    settingsService.getLogoUrl(logoId)
      .then((u) => { url = u; if (live) setLogoUrl(u); })
      .catch(() => { /* a missing logo prints a plainer paper, not an error */ });
    return () => {
      live = false;
      if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    };
  }, [logoId]);

  const contact = contactLines(settings);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
      {logoUrl && (
        <Box component="img" src={logoUrl} alt=""
          sx={{ maxHeight: '0.9in', maxWidth: '2.2in', objectFit: 'contain' }} />
      )}
      <Box sx={{ ml: logoUrl ? 'auto' : 0, textAlign: logoUrl ? 'right' : 'left' }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          {settings?.company_name || DEFAULT_COMPANY_NAME}
        </Typography>
        {contact.map((line) => (
          <Typography key={line} variant="body2" color="text.secondary">{line}</Typography>
        ))}
      </Box>
    </Box>
  );
};

export default Letterhead;
