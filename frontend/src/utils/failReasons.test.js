import { mergeAndOrderFailReasons } from './failReasons';

describe('mergeAndOrderFailReasons', () => {
  test('Other is last when remote data already contains it', () => {
    const remote = ['Other', 'Reason A', 'Reason B'];
    const result = mergeAndOrderFailReasons(remote, []);
    expect(result).toEqual(['Reason A', 'Reason B', 'Other']);
  });

  test('Other is last when required reasons are merged', () => {
    const remote = ['Reason A', 'Other'];
    const required = ['Did not search for member'];
    const result = mergeAndOrderFailReasons(remote, required);
    expect(result).toEqual(['Reason A', 'Did not search for member', 'Other']);
  });

  test('Did not search for member appears before Other', () => {
    const remote = ['Reason A', 'Other', 'Reason B'];
    const required = ['Did not search for member'];
    const result = mergeAndOrderFailReasons(remote, required);
    expect(result).toEqual(['Reason A', 'Reason B', 'Did not search for member', 'Other']);
  });

  test('no duplicate Other (case-insensitive)', () => {
    const remote = ['other', 'Reason A', 'Other', 'OTHER'];
    const result = mergeAndOrderFailReasons(remote, []);
    expect(result).toEqual(['Reason A', 'Other']);
  });

  test('no duplicate Did not search for member', () => {
    const remote = ['Did not search for member', 'Reason A', 'Other'];
    const required = ['Did not search for member'];
    const result = mergeAndOrderFailReasons(remote, required);
    expect(result).toEqual(['Did not search for member', 'Reason A', 'Other']);
  });

  test('remote order is preserved for all other reasons', () => {
    const remote = ['Reason B', 'Reason A', 'Reason C', 'Other'];
    const required = ['Did not search for member'];
    const result = mergeAndOrderFailReasons(remote, required);
    expect(result).toEqual(['Reason B', 'Reason A', 'Reason C', 'Did not search for member', 'Other']);
  });

  test('stale local override path still produces correct final ordering', () => {
    const staleLocal = ['Legacy Local Fail', 'Other', 'Legacy Local Fail', 'other'];
    const required = ['Did not search for member'];
    const result = mergeAndOrderFailReasons(staleLocal, required);
    expect(result).toEqual(['Legacy Local Fail', 'Did not search for member', 'Other']);
  });
});
