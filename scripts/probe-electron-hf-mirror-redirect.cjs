const { app, net, session } = require('electron');

const MARKER = 'PHRIO_HF_MIRROR_REDIRECT_PROBE';
const TIMEOUT_MILLISECONDS = 30_000;
const INITIAL_URL =
  'https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/'
  + 'resolve/8e40c43232a1c5c66c82111efc5820d3accca11b/encoder.int8.onnx?download=true';
const EXPECTED_BYTES = 165_462_184;
const EXPECTED_SHA256 =
  '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a';

function headerShape(headers, name) {
  const value = headers[name];
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return {
    type: Array.isArray(value) ? 'array' : typeof value,
    count: entries.length,
    lengths: entries.map((entry) => entry.length),
  };
}

function singleHeader(headers, name) {
  const value = headers[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) && value.length === 1 ? value[0] : null;
}

function safePathShape(pathname) {
  const segments = pathname.split('/').filter(Boolean);
  return {
    length: pathname.length,
    segmentCount: segments.length,
    segmentLengths: segments.map((segment) => segment.length),
    firstSegment: segments[0] ?? '',
    firstSegmentMatches: /^xet-bridge-[a-z0-9-]+$/u.test(segments[0] ?? ''),
    secondSegmentIsHex24: /^[a-f0-9]{24}$/u.test(segments[1] ?? ''),
    thirdSegmentIsHex64: /^[a-f0-9]{64}$/u.test(segments[2] ?? ''),
    exactCasShape: /^\/xet-bridge-[a-z0-9-]+\/[a-f0-9]{24}\/[a-f0-9]{64}$/u.test(pathname),
    encodedTraversal: /%2f|%5c|%2e/iu.test(pathname),
    containsTraversal: pathname.includes('..') || pathname.includes('\\'),
  };
}

function requestHop(url) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url,
      session: session.defaultSession,
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        Range: 'bytes=0-0',
        'User-Agent': 'Phrio-safe-hf-mirror-probe/0.1',
      },
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      bypassCustomProtocolHandlers: true,
    });
    let redirectDelivered = false;
    request.on('redirect', (statusCode, method, redirectUrl, responseHeaders) => {
      redirectDelivered = true;
      let parsed;
      try {
        parsed = new URL(redirectUrl);
      } catch {
        reject(new Error('redirect URL was not parseable'));
        return;
      }
      const linkedSize = singleHeader(responseHeaders, 'x-linked-size');
      const linkedEtag = singleHeader(responseHeaders, 'x-linked-etag');
      const normalizedEtag = linkedEtag?.startsWith('"') && linkedEtag.endsWith('"')
        ? linkedEtag.slice(1, -1)
        : linkedEtag;
      const location = singleHeader(responseHeaders, 'location');
      resolve({
        kind: 'redirect',
        statusCode,
        method,
        redirectUrl,
        redirect: {
          protocol: parsed.protocol,
          host: parsed.hostname,
          port: parsed.port,
          usernamePresent: parsed.username !== '',
          passwordPresent: parsed.password !== '',
          hashPresent: parsed.hash !== '',
          queryLength: parsed.search.length,
          path: safePathShape(parsed.pathname),
        },
        headers: {
          location: headerShape(responseHeaders, 'location'),
          linkedSize: headerShape(responseHeaders, 'x-linked-size'),
          linkedEtag: headerShape(responseHeaders, 'x-linked-etag'),
          locationMatchesRedirectUrl: location === redirectUrl,
          linkedSizeMatches: Number(linkedSize) === EXPECTED_BYTES,
          linkedEtagIsSha256: /^[a-f0-9]{64}$/u.test(normalizedEtag ?? ''),
          linkedEtagMatches: normalizedEtag === EXPECTED_SHA256,
        },
      });
    });
    request.on('response', (response) => {
      const current = new URL(url);
      const result = {
        kind: 'response',
        statusCode: response.statusCode,
        current: {
          protocol: current.protocol,
          host: current.hostname,
          port: current.port,
          queryLength: current.search.length,
          path: safePathShape(current.pathname),
        },
        headers: {
          contentLength: headerShape(response.headers, 'content-length'),
          contentRange: headerShape(response.headers, 'content-range'),
        },
      };
      response.on('error', () => undefined);
      response.destroy();
      resolve(result);
    });
    request.on('error', (error) => {
      if (!redirectDelivered) reject(new Error(`request failed: ${error.code ?? error.name}`));
    });
    request.end();
  });
}

async function verify() {
  await app.whenReady();
  const hops = [];
  let url = INITIAL_URL;
  for (let depth = 0; depth <= 4; depth += 1) {
    const result = await requestHop(url);
    if (result.kind === 'redirect') {
      const { redirectUrl, ...safeResult } = result;
      hops.push({ depth, ...safeResult });
      url = redirectUrl;
      continue;
    }
    hops.push({ depth, ...result });
    break;
  }
  process.stdout.write(`${MARKER} ${JSON.stringify({
    electronVersion: process.versions.electron,
    hops,
  })}\n`);
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
    process.stderr.write(`${MARKER} failed: ${error?.message ?? error}\n`);
    app.exit(1);
  },
);
