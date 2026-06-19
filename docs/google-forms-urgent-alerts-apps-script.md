# Google Forms Urgent Alerts Apps Script

This document provides an optional Google Apps Script template for urgent feedback and support alerts.

Do not commit credentials. Do not paste real phone numbers, private emails, API keys, webhook URLs, tokens, or private Sheet IDs into this repo.

Use Apps Script project properties for configuration.

## Supported Alert Channels

Required for email:

- `SUPPORT_ALERT_EMAIL`

Optional for SMS:

- `ENABLE_SMS_ALERTS`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `SUPPORT_PHONE_NUMBER`

Optional for Discord:

- `ENABLE_DISCORD_ALERTS`
- `DISCORD_WEBHOOK_URL`

Set `ENABLE_SMS_ALERTS` and `ENABLE_DISCORD_ALERTS` to `true` or `false`.

## Apps Script Template

Paste this into the Apps Script project attached to the linked response Sheet.

```javascript
/**
 * Urgent alert handler for MTS / SAM Google Forms responses.
 *
 * Required trigger:
 * Event source: From spreadsheet
 * Event type: On form submit
 *
 * Secrets and destinations must be stored in Apps Script project properties.
 * Do not paste real secrets into this file.
 */

function handleFormSubmit(event) {
  var namedValues = event && event.namedValues ? event.namedValues : {};
  var response = normalizeNamedValues_(namedValues);
  var urgencyInfo = detectUrgency_(response);

  if (!urgencyInfo.isUrgent) {
    return;
  }

  var alert = buildUrgentAlert_(response, urgencyInfo);
  sendEmailAlert_(alert);

  if (getProperty_('ENABLE_SMS_ALERTS') === 'true') {
    sendTwilioSmsAlert_(alert);
  }

  if (getProperty_('ENABLE_DISCORD_ALERTS') === 'true') {
    sendDiscordAlert_(alert);
  }
}

function normalizeNamedValues_(namedValues) {
  var result = {};
  Object.keys(namedValues || {}).forEach(function(key) {
    var value = namedValues[key];
    result[key] = Array.isArray(value) ? String(value[0] || '').trim() : String(value || '').trim();
  });
  return result;
}

function detectUrgency_(response) {
  var severity = getFirstValue_(response, ['Severity']);
  var urgency = getFirstValue_(response, ['Urgency']);

  if (severity.toLowerCase() === 'urgent') {
    return { isUrgent: true, sourceField: 'Severity', value: severity };
  }

  if (urgency.toLowerCase() === 'urgent') {
    return { isUrgent: true, sourceField: 'Urgency', value: urgency };
  }

  return { isUrgent: false, sourceField: '', value: '' };
}

function buildUrgentAlert_(response, urgencyInfo) {
  var app = getFirstValue_(response, ['App']) || 'Unknown app';
  var category = getFirstValue_(response, ['Report type', 'Support category']) || 'Uncategorized';
  var name = getFirstValue_(response, ['Name']) || 'Unknown reporter';
  var contactMethod = getFirstValue_(response, ['Preferred contact method']) || 'Not provided';
  var email = getFirstValue_(response, ['Email']) || '';
  var discord = getFirstValue_(response, ['Discord username']) || '';
  var phone = getFirstValue_(response, ['Phone number']) || '';
  var screenArea = getFirstValue_(response, ['Screen/area']) || '';
  var summary = getFirstValue_(response, [
    'What happened?',
    'Description of help needed',
    'Other details'
  ]) || 'No summary provided.';

  var contactDetails = [
    email ? 'Email: ' + email : '',
    discord ? 'Discord: ' + discord : '',
    phone ? 'Phone: provided in response Sheet' : ''
  ].filter(Boolean).join('\n');

  var subject = '[URGENT MTS/SAM] ' + app + ' - ' + category;
  var body = [
    'Urgent MTS/SAM form response received.',
    '',
    'App: ' + app,
    'Category: ' + category,
    'Urgency field: ' + urgencyInfo.sourceField,
    'Urgency value: ' + urgencyInfo.value,
    'Name: ' + name,
    'Preferred contact method: ' + contactMethod,
    screenArea ? 'Screen/area: ' + screenArea : '',
    contactDetails,
    '',
    'Short summary:',
    truncate_(summary, 1200),
    '',
    'Open the linked response Sheet to review the full response and any uploaded files.'
  ].filter(Boolean).join('\n');

  return {
    subject: subject,
    body: body,
    app: app,
    category: category,
    urgency: urgencyInfo.value,
    name: name,
    contactMethod: contactMethod,
    summary: truncate_(summary, 500)
  };
}

function sendEmailAlert_(alert) {
  var supportEmail = getRequiredProperty_('SUPPORT_ALERT_EMAIL');
  MailApp.sendEmail({
    to: supportEmail,
    subject: alert.subject,
    body: alert.body
  });
}

function sendTwilioSmsAlert_(alert) {
  var accountSid = getRequiredProperty_('TWILIO_ACCOUNT_SID');
  var authToken = getRequiredProperty_('TWILIO_AUTH_TOKEN');
  var fromNumber = getRequiredProperty_('TWILIO_FROM_NUMBER');
  var toNumber = getRequiredProperty_('SUPPORT_PHONE_NUMBER');

  var message = [
    'URGENT MTS/SAM',
    alert.app + ' - ' + alert.category,
    alert.name + ' via ' + alert.contactMethod,
    alert.summary
  ].join('\n');

  var url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(accountSid) + '/Messages.json';
  var payload = {
    To: toNumber,
    From: fromNumber,
    Body: truncate_(message, 1500)
  };

  UrlFetchApp.fetch(url, {
    method: 'post',
    payload: payload,
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(accountSid + ':' + authToken)
    },
    muteHttpExceptions: true
  });
}

function sendDiscordAlert_(alert) {
  var webhookUrl = getRequiredProperty_('DISCORD_WEBHOOK_URL');
  var content = [
    '**URGENT MTS/SAM form response**',
    '**App:** ' + alert.app,
    '**Category:** ' + alert.category,
    '**Urgency:** ' + alert.urgency,
    '**Name:** ' + alert.name,
    '**Contact method:** ' + alert.contactMethod,
    '**Summary:** ' + alert.summary
  ].join('\n');

  UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ content: truncate_(content, 1800) }),
    muteHttpExceptions: true
  });
}

function getFirstValue_(response, fieldNames) {
  for (var i = 0; i < fieldNames.length; i += 1) {
    var value = response[fieldNames[i]];
    if (value) {
      return value;
    }
  }
  return '';
}

function getProperty_(key) {
  return String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
}

function getRequiredProperty_(key) {
  var value = getProperty_(key);
  if (!value) {
    throw new Error('Missing required Apps Script property: ' + key);
  }
  return value;
}

function truncate_(value, maxLength) {
  var text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, Math.max(0, maxLength - 3)) + '...';
}
```

## Script Property Setup

In Apps Script:

1. Open Project Settings.
2. Scroll to Script Properties.
3. Add `SUPPORT_ALERT_EMAIL`.
4. Add `ENABLE_SMS_ALERTS` with `false` unless SMS is ready.
5. Add `ENABLE_DISCORD_ALERTS` with `false` unless Discord alerts are ready.
6. If SMS is enabled, add:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_NUMBER`
   - `SUPPORT_PHONE_NUMBER`
7. If Discord is enabled, add:
   - `DISCORD_WEBHOOK_URL`

Do not print these values in script logs.

## Trigger Setup

1. Open Apps Script.
2. Click Triggers.
3. Add Trigger.
4. Choose function: `handleFormSubmit`.
5. Choose deployment: Head.
6. Choose event source: From spreadsheet.
7. Choose event type: On form submit.
8. Save.
9. Authorize the script.

## Testing

1. Set `SUPPORT_ALERT_EMAIL` to the private support destination in Apps Script properties.
2. Keep `ENABLE_SMS_ALERTS` and `ENABLE_DISCORD_ALERTS` set to `false`.
3. Submit a normal response and confirm no alert sends.
4. Submit a feedback response with `Severity` set to `Urgent`.
5. Confirm the email alert arrives.
6. Submit a support response with `Urgency` set to `Urgent`.
7. Confirm the email alert arrives.
8. Turn on SMS only after Twilio properties are configured.
9. Turn on Discord only after the webhook URL is configured.
10. Confirm each optional channel with a test urgent response.

## Turning Channels On or Off

Email:

- Remove the trigger or clear `SUPPORT_ALERT_EMAIL` to stop email alerts.

SMS:

- Set `ENABLE_SMS_ALERTS` to `true` to enable.
- Set `ENABLE_SMS_ALERTS` to `false` to disable.

Discord:

- Set `ENABLE_DISCORD_ALERTS` to `true` to enable.
- Set `ENABLE_DISCORD_ALERTS` to `false` to disable.

## Notes for Other Alert Tools

Zapier, Make, IFTTT, Pushover, and carrier email-to-text can also be used. Keep their destination addresses, tokens, URLs, and phone numbers outside this repo. If using one of those tools, filter on:

- `Severity` equals `Urgent`
- or `Urgency` equals `Urgent`

The alert should include:

- App
- Report type or support category
- Severity or urgency
- Name
- Preferred contact method
- Short summary

