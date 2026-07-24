const assert = require('node:assert/strict');
const http = require('node:http');
const { app, net, session } = require('electron');

const MARKER = 'PHRIO_ELECTRON_SYSTEM_NETWORK';
const TIMEOUT_MILLISECONDS = 10_000;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => {
    const forceClose = setTimeout(() => {
      server.closeAllConnections?.();
    }, 250);
    forceClose.unref();
    server.close(() => {
      clearTimeout(forceClose);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

async function verify() {
  await app.whenReady();
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.url === '/redirect') {
      response.writeHead(302, {
        Location: '/bytes',
        'X-Linked-Etag': '"pinned-test-etag"',
        'X-Linked-Size': '4',
      });
      response.end();
      return;
    }
    if (request.url === '/bytes') {
      const body = Buffer.from([1, 2, 3, 4]);
      response.writeHead(206, {
        'Content-Length': String(body.byteLength),
        'Content-Range': 'bytes 0-3/4',
      });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  const address = await listen(server);
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const redirect = await new Promise((resolve, reject) => {
      const request = net.request({
        url: `${origin}/redirect`,
        method: 'GET',
        session: session.defaultSession,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        bypassCustomProtocolHandlers: true,
      });
      let redirectDelivered = false;
      request.on('redirect', (statusCode, method, redirectUrl, responseHeaders) => {
        redirectDelivered = true;
        resolve({ statusCode, method, redirectUrl, responseHeaders });
      });
      request.on('response', () => reject(new Error('unexpected redirect response event')));
      request.on('error', (error) => {
        // Electron reports its expected manual cancellation after redirect.
        if (!redirectDelivered) reject(error);
      });
      request.end();
    });

    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.method, 'GET');
    assert.equal(redirect.redirectUrl, `${origin}/bytes`);
    assert.deepEqual(redirect.responseHeaders.location, ['/bytes']);
    assert.deepEqual(redirect.responseHeaders['x-linked-size'], ['4']);
    assert.deepEqual(redirect.responseHeaders['x-linked-etag'], ['"pinned-test-etag"']);

    const ranged = await new Promise((resolve, reject) => {
      const request = net.request({
        url: `${origin}/bytes`,
        method: 'GET',
        session: session.defaultSession,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        bypassCustomProtocolHandlers: true,
        headers: {
          Accept: 'application/octet-stream',
          'Accept-Encoding': 'identity',
          Range: 'bytes=0-3',
          'If-Range': '"pinned-test-etag"',
          'User-Agent': 'Phrio-system-network-smoke/0.1',
        },
      });
      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end();
    });

    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.headers['content-length'], '4');
    assert.equal(ranged.headers['content-range'], 'bytes 0-3/4');
    assert.deepEqual(ranged.body, Buffer.from([1, 2, 3, 4]));
    assert.equal(requests[1].headers.range, 'bytes=0-3');
    assert.equal(requests[1].headers['if-range'], '"pinned-test-etag"');
    assert.equal(requests[1].headers['accept-encoding'], 'identity');
    assert.equal(requests[1].headers['user-agent'], 'Phrio-system-network-smoke/0.1');

    process.stdout.write(`${MARKER} ${JSON.stringify({
      electronVersion: process.versions.electron,
      redirectStatus: redirect.statusCode,
      rangeStatus: ranged.statusCode,
      streamedBytes: ranged.body.byteLength,
    })}\n`);
  } finally {
    await close(server);
  }
}

const timeout = setTimeout(() => {
  process.stderr.write(`${MARKER} timeout\n`);
  app.exit(1);
}, TIMEOUT_MILLISECONDS);
timeout.unref();

verify().then(
  () => {
    clearTimeout(timeout);
    app.quit();
  },
  (error) => {
    clearTimeout(timeout);
    process.stderr.write(`${MARKER} failed: ${error?.stack ?? error}\n`);
    app.exit(1);
  },
);
