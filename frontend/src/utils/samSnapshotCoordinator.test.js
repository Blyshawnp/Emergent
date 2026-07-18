import { createSamSnapshotCoordinator } from './samSnapshotCoordinator';

test('shares one in-flight request and one 60-second success cache across consumers', async () => {
  let currentTime = 0;
  let resolveFetch;
  const fetchSnapshot = jest.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
  const coordinator = createSamSnapshotCoordinator(fetchSnapshot, { now: () => currentTime });

  const first = coordinator.load();
  const second = coordinator.load();
  expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  resolveFetch({ ok: true, pendingRequests: { ok: true, requests: [] } });
  await Promise.all([first, second]);
  await coordinator.load();
  expect(fetchSnapshot).toHaveBeenCalledTimes(1);

  currentTime = 60001;
  resolveFetch = null;
  const refreshed = coordinator.load();
  expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  resolveFetch({ ok: true, pendingRequests: { ok: true, requests: [] } });
  await refreshed;
});

test('manual refresh bypasses the success cache once', async () => {
  const fetchSnapshot = jest.fn().mockResolvedValue({ ok: true });
  const coordinator = createSamSnapshotCoordinator(fetchSnapshot);
  await coordinator.load();
  await coordinator.load({ force: true });
  expect(fetchSnapshot).toHaveBeenCalledTimes(2);
});

test('quota failure enters bounded backoff and keeps stale successful sections visible', async () => {
  let currentTime = 0;
  const fetchSnapshot = jest.fn()
    .mockResolvedValueOnce({ ok: true, headsetReviews: { ok: true, pending: [{ review_id: 'one' }] } })
    .mockResolvedValueOnce({ ok: false, headsetReviews: { ok: false, pending: [] } });
  const coordinator = createSamSnapshotCoordinator(fetchSnapshot, { now: () => currentTime, cacheMs: 10 });
  await coordinator.load();
  currentTime = 11;
  const failed = await coordinator.load();
  expect(failed.headsetReviews.pending).toHaveLength(1);
  expect(failed.stale).toBe(true);
  await coordinator.load();
  expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  expect(failed.backoffUntil).toBe(60011);
});
