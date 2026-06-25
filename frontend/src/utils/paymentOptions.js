export const defaultPaymentOptions = {
  card: [
    {
      id: 'default',
      label: 'Default',
      type: 'American Express',
      number: '3782 822463 10005',
      exp: '07/2027',
      cvv: '1928',
    },
    {
      id: 'additional_1',
      label: 'American Express',
      type: 'American Express',
      number: '3714 496353 98431',
      exp: '08/28',
      cvv: '1827',
    },
    {
      id: 'additional_2',
      label: 'Discover',
      type: 'Discover',
      number: '6011 0009 9013 9424',
      exp: '06/28',
      cvv: '624',
    },
  ],
  eft: [
    {
      id: 'default',
      label: 'Default',
      routing: '021000021',
      account: '1357902468',
    },
    {
      id: 'additional_1',
      label: 'EFT 2',
      routing: '011401533',
      account: '032109876',
    },
    {
      id: 'additional_2',
      label: 'EFT 3',
      routing: '091000019',
      account: '654345678',
    },
  ],
};

function valueOrDefault(value, fallback) {
  const text = String(value || '').trim();
  return text || fallback;
}

function slugifyId(value, fallback) {
  const id = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id || fallback;
}

export function normalizePaymentOptionList(items, type) {
  const defaults = defaultPaymentOptions[type] || [];
  const source = Array.isArray(items) && items.length ? items : defaults;
  const seen = new Set();
  const normalized = source.map((item, index) => {
    const fallback = defaults[index] || defaults[0] || {};
    const baseId = index === 0 ? 'default' : slugifyId(item?.id || item?.label, `${type}_${index}`);
    const id = seen.has(baseId) ? `${baseId}_${index}` : baseId;
    seen.add(id);

    if (type === 'card') {
      return {
        id,
        label: valueOrDefault(item?.label, fallback.label || (index === 0 ? 'Default' : `Card ${index + 1}`)),
        type: valueOrDefault(item?.type, fallback.type || ''),
        number: valueOrDefault(item?.number, fallback.number || ''),
        exp: valueOrDefault(item?.exp, fallback.exp || ''),
        cvv: valueOrDefault(item?.cvv, fallback.cvv || ''),
      };
    }

    return {
      id,
      label: valueOrDefault(item?.label, fallback.label || (index === 0 ? 'Default' : `EFT ${index + 1}`)),
      routing: valueOrDefault(item?.routing, fallback.routing || ''),
      account: valueOrDefault(item?.account, fallback.account || ''),
    };
  });

  if (!normalized.some((item) => item.id === 'default')) {
    const fallbackDefault = defaults[0] || {};
    normalized.unshift(type === 'card'
      ? { ...fallbackDefault, id: 'default', label: 'Default' }
      : { ...fallbackDefault, id: 'default', label: 'Default' });
  }

  return normalized;
}

function legacyCardOptions(pay) {
  const defaults = defaultPaymentOptions.card;
  return [
    {
      ...defaults[0],
      type: valueOrDefault(pay.cc_type, defaults[0].type),
      number: valueOrDefault(pay.cc_number, defaults[0].number),
      exp: valueOrDefault(pay.cc_exp, defaults[0].exp),
      cvv: valueOrDefault(pay.cc_cvv, defaults[0].cvv),
    },
    {
      ...defaults[1],
      type: valueOrDefault(pay.cc_additional_1_type, defaults[1].type),
      number: valueOrDefault(pay.cc_additional_1_number, defaults[1].number),
      exp: valueOrDefault(pay.cc_additional_1_exp, defaults[1].exp),
      cvv: valueOrDefault(pay.cc_additional_1_cvv, defaults[1].cvv),
    },
    {
      ...defaults[2],
      type: valueOrDefault(pay.cc_additional_2_type, defaults[2].type),
      number: valueOrDefault(pay.cc_additional_2_number, defaults[2].number),
      exp: valueOrDefault(pay.cc_additional_2_exp, defaults[2].exp),
      cvv: valueOrDefault(pay.cc_additional_2_cvv, defaults[2].cvv),
    },
  ];
}

function legacyEftOptions(pay) {
  const defaults = defaultPaymentOptions.eft;
  return [
    {
      ...defaults[0],
      routing: valueOrDefault(pay.eft_routing, defaults[0].routing),
      account: valueOrDefault(pay.eft_account, defaults[0].account),
    },
    {
      ...defaults[1],
      routing: valueOrDefault(pay.eft_additional_1_routing, defaults[1].routing),
      account: valueOrDefault(pay.eft_additional_1_account, defaults[1].account),
    },
    {
      ...defaults[2],
      routing: valueOrDefault(pay.eft_additional_2_routing, defaults[2].routing),
      account: valueOrDefault(pay.eft_additional_2_account, defaults[2].account),
    },
  ];
}

export function getPaymentOptionsFromSettings(payment = {}) {
  const pay = payment || {};

  return {
    card: normalizePaymentOptionList(pay.card_options || legacyCardOptions(pay), 'card'),
    eft: normalizePaymentOptionList(pay.eft_options || legacyEftOptions(pay), 'eft'),
  };
}

export function formatDonationAmountLabel(value) {
  const text = String(value ?? '').trim();
  if (!text || /^other$/i.test(text)) return text || 'Other';

  const withoutCurrency = text.replace(/^\$/, '').replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(withoutCurrency)) return text;

  const amount = Number(withoutCurrency);
  if (!Number.isFinite(amount)) return text;

  const hasCents = withoutCurrency.includes('.') && Number(withoutCurrency.split('.')[1] || 0) > 0;
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  })}`;
}

export function syncLegacyPaymentFields(payment = {}) {
  const card = normalizePaymentOptionList(payment.card_options, 'card');
  const eft = normalizePaymentOptionList(payment.eft_options, 'eft');
  const firstCard = card[0] || defaultPaymentOptions.card[0];
  const secondCard = card[1] || {};
  const thirdCard = card[2] || {};
  const firstEft = eft[0] || defaultPaymentOptions.eft[0];
  const secondEft = eft[1] || {};
  const thirdEft = eft[2] || {};

  return {
    ...payment,
    card_options: card,
    eft_options: eft,
    cc_type: firstCard.type || '',
    cc_number: firstCard.number || '',
    cc_exp: firstCard.exp || '',
    cc_cvv: firstCard.cvv || '',
    cc_additional_1_type: secondCard.type || '',
    cc_additional_1_number: secondCard.number || '',
    cc_additional_1_exp: secondCard.exp || '',
    cc_additional_1_cvv: secondCard.cvv || '',
    cc_additional_2_type: thirdCard.type || '',
    cc_additional_2_number: thirdCard.number || '',
    cc_additional_2_exp: thirdCard.exp || '',
    cc_additional_2_cvv: thirdCard.cvv || '',
    eft_routing: firstEft.routing || '',
    eft_account: firstEft.account || '',
    eft_additional_1_routing: secondEft.routing || '',
    eft_additional_1_account: secondEft.account || '',
    eft_additional_2_routing: thirdEft.routing || '',
    eft_additional_2_account: thirdEft.account || '',
  };
}
