import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';

test('public NSAT address can be encoded as a QR image', async () => {
  const address = `G${'A'.repeat(55)}`;
  const image = await QRCode.toDataURL(address, {
    errorCorrectionLevel: 'M', margin: 2, width: 240,
  });
  assert.match(image, /^data:image\/png;base64,/);
  assert.ok(Buffer.from(image.split(',')[1], 'base64').length > 100);
});
