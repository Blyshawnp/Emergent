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

test('forced post-mutation refresh supersedes an older in-flight response', async () => {
  const resolvers = [];
  const fetchSnapshot = jest.fn(() => new Promise((resolve) => resolvers.push(resolve)));
  const coordinator = createSamSnapshotCoordinator(fetchSnapshot);

  const staleLoad = coordinator.load();
  const freshLoad = coordinator.load({ force: true });
  expect(fetchSnapshot).toHaveBeenCalledTimes(2);

  resolvers[1]({ ok: true, headsetReviews: { ok: true, approved: [] } });
  const fresh = await freshLoad;
  resolvers[0]({ ok: true, headsetReviews: { ok: true, approved: [{ catalog_identity: 'deleted-row' }] } });
  await staleLoad;

  expect(fresh.headsetReviews.approved).toEqual([]);
  expect((await coordinator.load()).headsetReviews.approved).toEqual([]);
});

test('invalidate prevents a pending response from repopulating the cache', async () => {
  let resolveStale;
  const fetchSnapshot = jest.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
    .mockResolvedValueOnce({ ok: true, headsetReviews: { ok: true, approved: [] } });
  const coordinator = createSamSnapshotCoordinator(fetchSnapshot);

  const staleLoad = coordinator.load();
  coordinator.invalidate();
  const fresh = await coordinator.load({ force: true });
  resolveStale({ ok: true, headsetReviews: { ok: true, approved: [{ catalog_identity: 'deleted-row' }] } });
  await staleLoad;

  expect(fresh.headsetReviews.approved).toEqual([]);
  expect((await coordinator.load()).headsetReviews.approved).toEqual([]);
});
