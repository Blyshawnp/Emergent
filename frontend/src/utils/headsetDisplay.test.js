import { buildHeadsetDisplayLabel, getCandidateHeadset } from './headsetDisplay';

test('Brand Logitech and Model H390 display as Logitech H390', () => {
  expect(buildHeadsetDisplayLabel('Logitech', 'H390')).toBe('Logitech H390');
  expect(getCandidateHeadset({ headset_brand: 'Logitech', headset_model: 'H390' })).toEqual({
    brand: 'Logitech', model: 'H390', label: 'Logitech H390', separate: true,
  });
});

test('display label does not duplicate a brand already present in model text', () => {
  expect(buildHeadsetDisplayLabel('Logitech', 'Logitech H390')).toBe('Logitech H390');
});

test('legacy combined candidate headset remains a display-only fallback', () => {
  expect(getCandidateHeadset({ headset_brand: 'Logitech H390' })).toEqual({
    brand: '', model: '', label: 'Logitech H390', separate: false,
  });
});
