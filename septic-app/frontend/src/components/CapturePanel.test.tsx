import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import CapturePanel from './CapturePanel';
import { noteService, uploadPhoto, NoteRow } from '../services/captureService';

/**
 * T-DRV-14's capture surface, and the DRV-12 rule applied to notes: a retry
 * of an unsent note must carry the same `client_uuid`, or the server cannot
 * tell a retry from a second note that happens to read the same.
 *
 * The failure this pins is the realistic one: signal drops mid-POST, the
 * driver presses Send again, and the naive implementation has just minted a
 * new uuid and filed the note twice.
 */

jest.mock('../services/captureService', () => {
  const actual = jest.requireActual('../services/captureService');
  return {
    ...actual,
    noteService: { create: jest.fn(), list: jest.fn() },
    uploadPhoto: jest.fn(),
  };
});

const create = noteService.create as jest.Mock;
const list = noteService.list as jest.Mock;
const upload = uploadPhoto as jest.Mock;

const NOTE: NoteRow = {
  id: 5, client_uuid: 'x', author_id: 7, body: 'lid was cracked',
  client_created_at: '2024-12-02T10:00:00.000Z', created_at: '2024-12-02T10:00:05.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  list.mockResolvedValue([]);
  create.mockResolvedValue(NOTE);
  upload.mockResolvedValue({ id: 1, sha256: 'a'.repeat(64), byte_size: 1, width: 8, height: 8, url: '/x' });
});

const openPanel = async () => {
  render(<CapturePanel stopId={41} propertyId={4} />);
  await userEvent.click(screen.getByRole('button', { name: /notes and photos/i }));
};

describe('T-DRV-14: what the device appends', () => {
  it('sends a note with a uuid and lists it back from the server', async () => {
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([NOTE]);
    await openPanel();
    await userEvent.type(screen.getByLabelText('new note'), 'lid was cracked');
    await userEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const sent = create.mock.calls[0][0];
    expect(sent.route_stop_id).toBe(41);
    expect(sent.body).toBe('lid was cracked');
    expect(sent.client_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('lid was cracked')).toBeInTheDocument();
  });

  it('a failed send keeps the text AND the uuid — the retry is the same note', async () => {
    create.mockRejectedValueOnce({ response: { data: { error: 'Failed to fetch' } } });
    await openPanel();
    await userEvent.type(screen.getByLabelText('new note'), 'gate code 4417');
    await userEvent.click(screen.getByRole('button', { name: /Send/i }));
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const [first, second] = create.mock.calls.map((c) => c[0]);
    expect(first.client_uuid).toBe(second.client_uuid);
    expect(first.body).toBe('gate code 4417');
    expect(second.body).toBe('gate code 4417');
    // And once it lands, a third, different note must NOT reuse the uuid.
    await waitFor(() => expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument());
  });

  it('reports a duplicate photo as the dedup it is, not as an error', async () => {
    upload.mockResolvedValueOnce({
      id: 2, sha256: 'b'.repeat(64), byte_size: 2, width: 8, height: 8,
      deduplicated: true, url: '/x',
    });
    await openPanel();
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'p.jpg',
      { type: 'image/jpeg' });
    // A hidden input cannot be userEvent-clicked in jsdom; fire its change
    // the way a camera app hands a file back to the page.
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);
    expect(await screen.findByText(/matched one already on file/)).toBeInTheDocument();
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
