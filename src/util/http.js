// 18.09.26

// Requests to the sites: a session keeps its cookies and headers, like requests.Session of the python version

const { HttpError, RequestError, isNetworkError, waitOnline, sleep } = require('./errors');

const TIMEOUT = 20;
const RETRY_CODES = new Set([429, 500, 502, 503, 504]);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;


// [ cookies ]
class CookieJar {
  constructor() {
    this.items = [];
  }

  store(setCookies, url) {
    const host = new URL(url).hostname.toLowerCase();

    for (const line of setCookies) {
      const [pair, ...attributes] = line.split(';');
      const index = pair.indexOf('=');
      if (index <= 0) continue;

      const cookie = { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: host, hostOnly: true, expires: null };

      for (const attribute of attributes) {
        const [key, ...rest] = attribute.split('=');
        const value = rest.join('=').trim();

        switch (key.trim().toLowerCase()) {
          case 'domain':
            if (value) Object.assign(cookie, { domain: value.replace(/^\./, '').toLowerCase(), hostOnly: false });
            break;
          case 'max-age':
            cookie.expires = Date.now() + Number(value) * 1000;
            break;
          case 'expires':
            if (cookie.expires === null && !Number.isNaN(Date.parse(value))) cookie.expires = Date.parse(value);
            break;
          default:
            break;
        }
      }

      this.items = this.items.filter((other) => !(other.name === cookie.name && other.domain === cookie.domain));
      if (cookie.expires === null || cookie.expires > Date.now()) this.items.push(cookie);
    }
  }

  matching(url) {
    const host = new URL(url).hostname.toLowerCase();
    const now = Date.now();

    return this.items.filter((cookie) => (cookie.expires === null || cookie.expires > now)
      && (host === cookie.domain || (!cookie.hostOnly && host.endsWith(`.${cookie.domain}`))));
  }

  get(name) {
    const now = Date.now();
    return this.items.find((cookie) => cookie.name === name && (cookie.expires === null || cookie.expires > now))?.value;
  }
}

class Session {
  constructor(headers = {}) {
    this.headers = { ...headers };
    this.cookies = new CookieJar();
  }
}


// [ answer ]
class Response {
  constructor(raw, url, history, body) {
    this.status = raw.status;
    this.ok = raw.status >= 200 && raw.status < 400;
    this.url = url;
    this.history = history;
    this.headers = raw.headers;
    this.content = body;
    this.isRedirect = REDIRECT_CODES.has(raw.status) && raw.headers.has('location');
  }

  get text() {
    return this.content.toString('utf8');
  }

  json() {
    return JSON.parse(this.text);
  }

  raiseForStatus() {
    if (this.status >= 400) throw new HttpError(this);
    return this;
  }
}


// [ request ]
function buildUrl(url, params) {
  if (!params) return url;

  const address = new URL(url);
  const pairs = Array.isArray(params) ? params : Object.entries(params);

  for (const [key, value] of pairs) {
    if (value !== null && value !== undefined) address.searchParams.append(key, String(value));
  }

  return address.href;
}

function buildBody(options, headers) {
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    return JSON.stringify(options.json);
  }
  if (options.form) return options.form;
  if (options.data !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    return new URLSearchParams(Object.entries(options.data).map(([key, value]) => [key, String(value)])).toString();
  }
  return options.body;
}

function toRequestError(error, url, timedOut) {
  if (timedOut) return new RequestError(`timed out (${url})`, { code: 'ETIMEDOUT', url, cause: error });

  let code = null;
  for (let current = error; current && !code; current = current.cause) code = typeof current.code === 'string' ? current.code : null;

  return new RequestError(error.cause?.message || error.message, { code, url, cause: error });
}

/** Read the whole body, the timer is started again at every piece that arrives */
async function readBody(raw, timer, onChunk) {
  if (!raw.body) return Buffer.alloc(0);

  const reader = raw.body.getReader();
  const chunks = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    timer.reset();
    chunks.push(value);
    size += value.length;
    if (onChunk) onChunk(value.length);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)), size);
}

/** Abort the request when nothing arrives for timeout seconds, like the read timeout of requests */
function idleTimer(controller, seconds) {
  const timer = {
    expired: false,
    handle: null,
    reset() {
      clearTimeout(timer.handle);
      timer.handle = setTimeout(() => {
        timer.expired = true;
        controller.abort();
      }, seconds * 1000);
    },
    clear() {
      clearTimeout(timer.handle);
    },
  };

  timer.reset();
  return timer;
}

/**
 * A single request, following the redirects by hand: the cookies of every step are kept
 * and the addresses passed through are in response.history
 */
async function send(method, url, options = {}) {
  const session = options.session || null;
  const timeout = options.timeout ?? TIMEOUT;
  const history = [];
  let current = buildUrl(url, options.params);
  let verb = method.toUpperCase();
  let extraHeaders = {};
  let body = buildBody(options, extraHeaders);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers = { ...(session?.headers || {}), ...extraHeaders, ...(options.headers || {}) };
    const cookies = [...(session ? session.cookies.matching(current).map((cookie) => [cookie.name, cookie.value]) : []),
      ...Object.entries(options.cookies || {})];

    if (cookies.length) headers.cookie = cookies.map(([name, value]) => `${name}=${value}`).join('; ');

    const controller = new AbortController();
    const timer = idleTimer(controller, timeout);
    const signals = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let raw;

    try {
      raw = await fetch(current, { method: verb, headers, body, redirect: 'manual', signal: signals });
    } catch (error) {
      timer.clear();
      if (options.signal?.aborted) throw options.signal.reason || error;
      throw toRequestError(error, current, timer.expired);
    }

    if (session) session.cookies.store(raw.headers.getSetCookie(), current);

    const location = raw.headers.get('location');
    if (options.redirect !== false && REDIRECT_CODES.has(raw.status) && location) {
      timer.clear();
      await raw.body?.cancel().catch(() => {});
      history.push(current);

      // The browsers turn a redirected post into a get, requests does the same
      if (raw.status === 303 || ((raw.status === 301 || raw.status === 302) && verb === 'POST')) {
        verb = 'GET';
        body = undefined;
        extraHeaders = {};
      }

      current = new URL(location, current).href;
      continue;
    }

    try {
      const content = await readBody(raw, timer, options.onChunk);
      return new Response(raw, current, history, content);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      throw toRequestError(error, current, timer.expired);
    } finally {
      timer.clear();
    }
  }

  throw new RequestError(`Troppi reindirizzamenti (${url})`, { code: 'EMAXREDIRECTS', url });
}

/**
 * Request with a time limit, tried again when the connection breaks or the server is busy.
 * With wait, a missing internet is waited for (downloads), without it the error comes at once (pages of the gui).
 */
async function request(method, url, options = {}) {
  const retries = options.retries ?? 3;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await send(method, url, options);

      if (!RETRY_CODES.has(response.status) || attempt === retries) return response;

    } catch (error) {
      if (attempt === retries || !isNetworkError(error)) throw error;

      // No internet: a download waits for it, the gui tries once more and then answers
      if (options.wait && !(await waitOnline(options.check))) throw error;
      if (!options.wait && attempt >= 1) throw error;
    }

    await sleep(Math.min(2 ** attempt, 10) * 1000);
  }

  throw new RequestError(`Nessuna risposta da ${url}`, { url });
}

function get(url, options = {}) {
  return request('GET', url, options);
}

module.exports = { Session, CookieJar, Response, send, request, get, TIMEOUT };
