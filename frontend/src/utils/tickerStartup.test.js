import {
  createTickerRequestGuard,
  TICKER_CACHE_KEY,
  TICKER_CACHE_MAX_AGE_MS,
  readTickerCache,
  refreshTickerNotifications,
  resetTickerRefreshForTests,
  writeTickerCache,
} from './tickerStartup';

function storageWith(value = null) {
  const data = new Map(value === null ? [] : [[TICKER_CACHE_KEY, value]]);
  return {
    getItem: jest.fn((key) => data.get(key) ?? null),
    setItem: jest.fn((key, nextValue) => data.set(key, nextValue)),
  };
}

const livePayload = {
  source: 'google',
  tickerMessages: [{
    id: 'live', type: 'info', title: 'Live', message: 'Remote message', showTicker: true,
  }],
  banners: [],
  popups: [],
};

afterEach(() => resetTickerRefreshForTests());

test('successful normalized remote ticker is cached and restored synchronously', () => {
  const storage = storageWith();
  expect(writeTickerCache(livePayload, storage, 1000)).toBe(true);
  expect(readTickerCache(storage, 1001).tickerMessages).toEqual([
    expect.objectContaining({ id: 'live', title: 'Live', message: 'Remote message' }),
  ]);
});

test('missing, corrupt, stale, malformed, and failed content preserve the neutral fallback', () => {
  expect(readTickerCache(storageWith(), 1000).tickerMessages).toEqual([]);
  expect(readTickerCache(storageWith('{bad json'), 1000).tickerMessages).toEqual([]);
  const staleStorage = storageWith();
  writeTickerCache(livePayload, staleStorage, 1000);
  expect(readTickerCache(staleStorage, 1000 + TICKER_CACHE_MAX_AGE_MS + 1).tickerMessages).toEqual([]);
  expect(writeTickerCache({ source: 'google', tickerMessages: 'bad' }, storageWith(), 1000)).toBe(false);
  expect(writeTickerCache({ ...livePayload, source: 'fallback' }, storageWith(), 1000)).toBe(false);
});

test('empty successful content is valid while disabled and blank rows are removed', () => {
  const storage = storageWith();
  expect(writeTickerCache({
    ...livePayload,
    tickerMessages: [
      { id: 'disabled', type: 'info', message: 'No', showTicker: false },
      { id: 'blank', type: 'info', message: '   ', showTicker: true },
    ],
  }, storage, 1000)).toBe(true);
  expect(readTickerCache(storage, 1001).tickerMessages).toEqual([]);
});

test('urgent and expired messages are not replayed from a prior session', () => {
  const storage = storageWith();
  writeTickerCache({
    ...livePayload,
    tickerMessages: [
      { id: 'urgent', type: 'urgent', message: 'Do not replay', showTicker: true },
      { id: 'expired', type: 'warning', message: 'Old', showTicker: true, endTime: '2026-01-01T00:00:00Z' },
      { id: 'safe', type: 'info', message: 'Safe cached message', showTicker: true },
    ],
  }, storage, Date.parse('2026-01-02T00:00:00Z'));
  expect(readTickerCache(storage, Date.parse('2026-01-02T00:00:01Z')).tickerMessages)
    .toEqual([expect.objectContaining({ id: 'safe' })]);
});

test('concurrent refreshes share one request and a later request can recover', async () => {
  let resolveRequest;
  const load = jest.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
  const first = refreshTickerNotifications(load);
  const second = refreshTickerNotifications(load);
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  resolveRequest(livePayload);
  await expect(first).resolves.toBe(livePayload);
  await expect(second).resolves.toBe(livePayload);

  load.mockImplementationOnce(() => Promise.resolve(livePayload));
  await refreshTickerNotifications(load);
  expect(load).toHaveBeenCalledTimes(2);
});

test('stale response tokens cannot replace a newer refresh', () => {
  const guard = createTickerRequestGuard();
  const first = guard.begin();
  const second = guard.begin();
  expect(guard.isLatest(first)).toBe(false);
  expect(guard.isLatest(second)).toBe(true);
  guard.invalidate();
  expect(guard.isLatest(second)).toBe(false);
});
