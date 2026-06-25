import { formatDonationAmountLabel } from './paymentOptions';

test('formats donation amounts as currency labels', () => {
  expect(formatDonationAmountLabel('16')).toBe('$16');
  expect(formatDonationAmountLabel('12.50')).toBe('$12.50');
  expect(formatDonationAmountLabel('25')).toBe('$25');
  expect(formatDonationAmountLabel('100')).toBe('$100');
  expect(formatDonationAmountLabel('Other')).toBe('Other');
});
