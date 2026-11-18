import { randomBytes } from 'node:crypto';
import { createLab } from './server.mjs';
import { createProvider } from './shipping.mjs';

const sessionPassword = randomBytes(12).toString('hex');
const shippingKey = randomBytes(24).toString('hex');
const provider = createProvider({ key: shippingKey, port: 0 });
const shippingUrl = await provider.listen();
const app = createLab({
  port: 0, dbPath: ':memory:', password: sessionPassword,
  readToken: randomBytes(24).toString('hex'), shippingUrl,
  shippingKey, shippingTimeout: 1000
});
console.log('Open', await app.listen());
console.log('Session password:', sessionPassword);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await provider.close();
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
