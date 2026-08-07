import axios from 'axios';

import api from './api';

jest.mock('axios');

test('reconcileHistory posts to the History reconciliation endpoint with the requested timeout', async () => {
  axios.mockResolvedValue({ data: { ok: true, history: [], stats: {} } });

  await expect(api.reconcileHistory(20000)).resolves.toEqual({ ok: true, history: [], stats: {} });

  expect(axios).toHaveBeenCalledWith(expect.objectContaining({
    method: 'POST',
    url: 'http://127.0.0.1:8600/api/history/reconcile',
    timeout: 20000,
  }));
});
