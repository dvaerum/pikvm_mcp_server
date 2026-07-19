/**
 * Tests client.resetHid() against a local mock PiKVM origin (loopback, no
 * network). Guards the overload contract and the endpoints it drives:
 *   - resetHid()            -> POST /hid/reset only, returns void
 *   - resetHid({})          -> reset + re-read /hid, returns the HidProfile
 *   - resetHid({reconnectUsb}) -> also toggles set_connected 0->1
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PiKVMClient } from '../client.js';

let origin: http.Server;
let port: number;
let requests: string[];

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/hid') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          result: {
            online: true,
            mouse: { absolute: false, online: true },
            keyboard: { online: true },
          },
        }),
      );
      return;
    }
    // reset + set_connected are POSTs that return an empty ok body.
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"result":{}}');
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  port = (origin.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => origin.close(() => r()));
});

beforeEach(() => {
  requests = [];
});

function client(): PiKVMClient {
  return new PiKVMClient({
    host: `http://127.0.0.1:${port}`,
    username: 'admin',
    password: 'pw',
    verifySsl: false,
  });
}

describe('PiKVMClient.resetHid', () => {
  it('no-arg form fires only the soft reset and returns void', async () => {
    const result = await client().resetHid();
    expect(result).toBeUndefined();
    expect(requests).toEqual(['POST /api/hid/reset']);
  });

  it('with options, resets then re-reads the HID profile', async () => {
    const profile = await client().resetHid({ settleMs: 0 });
    expect(requests).toEqual(['POST /api/hid/reset', 'GET /api/hid']);
    expect(profile).toEqual({
      online: true,
      mouseAbsolute: false,
      mouseOnline: true,
      keyboardOnline: true,
    });
  });

  it('reconnectUsb toggles set_connected 0 -> 1 around the reset', async () => {
    await client().resetHid({ reconnectUsb: true, settleMs: 0 });
    expect(requests).toEqual([
      'POST /api/hid/reset',
      'POST /api/hid/set_connected?connected=0',
      'POST /api/hid/set_connected?connected=1',
      'GET /api/hid',
    ]);
  });
});
