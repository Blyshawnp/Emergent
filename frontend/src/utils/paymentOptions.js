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

export function getPaymentOptionsFromSettings(payment = {}) {
  const pay = payment || {};
  const defaults = defaultPaymentOptions;

  return {
    card: [
      {
        ...defaults.card[0],
        type: valueOrDefault(pay.cc_type, defaults.card[0].type),
        number: valueOrDefault(pay.cc_number, defaults.card[0].number),
        exp: valueOrDefault(pay.cc_exp, defaults.card[0].exp),
        cvv: valueOrDefault(pay.cc_cvv, defaults.card[0].cvv),
      },
      {
        ...defaults.card[1],
        type: valueOrDefault(pay.cc_additional_1_type, defaults.card[1].type),
        number: valueOrDefault(pay.cc_additional_1_number, defaults.card[1].number),
        exp: valueOrDefault(pay.cc_additional_1_exp, defaults.card[1].exp),
        cvv: valueOrDefault(pay.cc_additional_1_cvv, defaults.card[1].cvv),
      },
      {
        ...defaults.card[2],
        type: valueOrDefault(pay.cc_additional_2_type, defaults.card[2].type),
        number: valueOrDefault(pay.cc_additional_2_number, defaults.card[2].number),
        exp: valueOrDefault(pay.cc_additional_2_exp, defaults.card[2].exp),
        cvv: valueOrDefault(pay.cc_additional_2_cvv, defaults.card[2].cvv),
      },
    ],
    eft: [
      {
        ...defaults.eft[0],
        routing: valueOrDefault(pay.eft_routing, defaults.eft[0].routing),
        account: valueOrDefault(pay.eft_account, defaults.eft[0].account),
      },
      {
        ...defaults.eft[1],
        routing: valueOrDefault(pay.eft_additional_1_routing, defaults.eft[1].routing),
        account: valueOrDefault(pay.eft_additional_1_account, defaults.eft[1].account),
      },
      {
        ...defaults.eft[2],
        routing: valueOrDefault(pay.eft_additional_2_routing, defaults.eft[2].routing),
        account: valueOrDefault(pay.eft_additional_2_account, defaults.eft[2].account),
      },
    ],
  };
}
