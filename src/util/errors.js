// 18.09.26

const net = require('net');
const { logFile } = require('./log');

const PROBE_HOSTS = [['1.1.1.1', 443], ['8.8.8.8', 443], ['9.9.9.9', 443]];
const OFFLINE_LIMIT = 30 * 60;          // After this the download gives up, the manager tries again later
const OFFLINE_TEXT = 'Connessione a internet assente o instabile';
const DISK_FULL_TEXT = 'Spazio su disco esaurito, libera spazio e riprova';
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const REFUSED_CODES = new Set(['ECONNREFUSED']);
const TLS_PATTERN = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|HOSTNAME_MISMATCH/;
const NETWORK_CODES = new Set([...DNS_CODES, ...TIMEOUT_CODES, ...REFUSED_CODES, 'ECONNRESET', 'ECONNABORTED', 'EPIPE',
  'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_ABORTED']);
const HTTP_REASONS = {
  400: 'richiesta rifiutata',
  401: 'accesso negato',
  403: 'accesso negato, il sito blocca la richiesta o il link è scaduto',
  404: "pagina non trovata, il contenuto è stato rimosso o l'indirizzo è cambiato",
  410: 'contenuto rimosso',
  419: 'sessione scaduta',
  429: 'troppe richieste, il sito chiede di rallentare',
  500: 'errore interno del sito',
  502: 'il sito non risponde',
  503: 'sito sovraccarico o in manutenzione',
  504: 'il sito non ha risposto in tempo',
};
const lastProbe = { time: 0, online: true, running: null };


/** An error with a message already written for the user */
class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** A download that did not work, with a message for the user */
class DownloadError extends AppError {
  constructor(message, retry = true) {
    super(message);
    this.retry = retry;         // False when trying again gives the same result
  }
}

class DiskFullError extends DownloadError {
  constructor(path = null) {
    super(DISK_FULL_TEXT, false);
    this.path = path;
  }
}

/** The site answered, but not with what the program expects */
class SiteError extends AppError {}

/** An answer that is not ok, raised by raiseForStatus */
class HttpError extends Error {
  constructor(response) {
    super(`HTTP ${response.status} ${response.url}`);
    this.name = 'HttpError';
    this.response = response;
  }
}

/** A connection that is missing or broken, not an answer of the site */
class RequestError extends Error {
  constructor(message, { code = null, url = null, cause = null } = {}) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.url = url;
    this.cause = cause;
  }
}


// [ network ]
function probe([host, port]) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3000 });
    const done = (online) => {
      socket.destroy();
      resolve(online);
    };

    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** True when internet answers, the answer is kept a few seconds so many downloads can ask */
async function isOnline() {
  if (Date.now() - lastProbe.time < 3000) return lastProbe.online;
  if (lastProbe.running) return lastProbe.running;

  lastProbe.running = (async () => {
    let online = false;

    for (const host of PROBE_HOSTS) {
      if (await probe(host)) {
        online = true;
        break;
      }
    }

    Object.assign(lastProbe, { time: Date.now(), online, running: null });
    return online;
  })();

  return lastProbe.running;
}

function isNetworkError(error) {
  return error instanceof RequestError || NETWORK_CODES.has(error?.code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until internet comes back. check() is called often, it throws to stop the wait (cancel).
 * Return false if internet is still missing after the limit.
 */
async function waitOnline(check = null, limit = OFFLINE_LIMIT) {
  const end = Date.now() + limit * 1000;

  while (Date.now() < end) {
    if (await isOnline()) return true;

    for (let step = 0; step < 10; step++) {
      if (check) check();
      await sleep(500);
    }
  }

  return false;
}

function getHost(url) {
  try {
    return new URL(url).hostname || url || 'il sito';
  } catch {
    return url || 'il sito';
  }
}

/** First code in the chain of causes, fetch hides the real reason inside */
function findCode(error) {
  let current = error;

  for (let depth = 0; current && depth < 6; depth++) {
    if (current.code && typeof current.code === 'string' && current.code !== 'RequestError') return current.code;
    current = current.cause;
  }

  return null;
}

/** What broke in a connection: internet, the name of the site, its answer or its certificate */
function describeNetwork(error) {
  if (!lastProbe.online) return OFFLINE_TEXT;

  const host = getHost(error.url);
  const code = error.code || findCode(error) || '';
  const text = `${error.message} ${error.cause?.message || ''}`.toLowerCase();

  if (TLS_PATTERN.test(code) || text.includes('certificate')) {
    return `Connessione sicura con ${host} non riuscita (certificato non valido): spesso è il provider che blocca il sito, prova un DNS come 1.1.1.1`;
  }
  if (DNS_CODES.has(code) || text.includes('getaddrinfo')) {
    return `Il dominio ${host} non esiste o non viene trovato: l'indirizzo è sbagliato o è cambiato, oppure il provider lo blocca (prova un DNS come 1.1.1.1)`;
  }
  if (TIMEOUT_CODES.has(code) || text.includes('timed out') || text.includes('timeout')) {
    return `${host} non ha risposto in tempo: il sito è lento o irraggiungibile, riprova tra poco`;
  }
  if (REFUSED_CODES.has(code) || text.includes('refused')) {
    return `${host} ha rifiutato la connessione: il sito è fermo o bloccato`;
  }

  return `Connessione con ${host} interrotta: rete instabile o sito irraggiungibile`;
}


// [ http ]
/** Host the request has been sent to, when it is not the one asked (a domain that has changed) */
function redirectedTo(response) {
  if (!response.history?.length) return null;

  const asked = getHost(response.history[0]);
  const final = getHost(response.url);
  return asked !== final ? final : null;
}

/** Answer that is not ok: who answered, the code and what it means */
function describeResponse(response, who = null) {
  const host = getHost(response.url);
  const code = response.status;
  let reason = HTTP_REASONS[code];

  if (!reason && code >= 520 && code <= 530) reason = 'il sito dietro Cloudflare non risponde';
  else if (!reason && code >= 500) reason = 'problema del server, di solito passa da solo';

  let text = who ? `${who} ${host}` : host;
  text += ` ha risposto con errore ${code}` + (reason ? `: ${reason}` : '');

  const moved = redirectedTo(response);
  if (moved) text += ` (la richiesta è stata spostata su ${moved})`;

  return text;
}


// [ disk ]
function isDiskFull(error) {
  return error?.code === 'ENOSPC' || error?.code === 'EDQUOT';
}


// [ text for the user ]
/** Phase of a download: an error raised inside says where it happened */
async function step(label, action) {
  try {
    return await action();
  } catch (error) {
    // The innermost phase is the most precise
    if (error && typeof error === 'object' && error.step == null) error.step = label;
    throw error;
  }
}

/** 'Il sito...' becomes 'il sito...', names like FFmpeg or AnimeUnity stay as they are */
function lowerFirst(text) {
  const first = text.split(' ', 1)[0].slice(1);
  return first && first === first.toLowerCase() && /[a-zà-ù]/.test(first) ? text[0].toLowerCase() + text.slice(1) : text;
}

function explain(error) {
  const name = error?.name || 'Error';
  const log = logFile();

  if (error instanceof AppError) return error.message;
  if (isDiskFull(error)) return DISK_FULL_TEXT;
  if (isNetworkError(error)) return describeNetwork(error);
  if (error instanceof HttpError) return describeResponse(error.response);
  if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EBUSY') {
    return `Permesso negato su ${error.path || 'un file'}: la cartella è protetta o il file è aperto in un altro programma`;
  }
  if (error?.code === 'ENOENT') {
    return error.path ? `File o cartella non trovati: ${error.path}` : `Percorso di un file vuoto (errore del programma), dettagli in ${log}`;
  }
  if (error?.syscall) {
    return error.path ? `Errore sul file ${error.path}: ${error.message}` : `Errore di sistema: ${error.message}`;
  }
  if (error instanceof SyntaxError) {
    return 'Il sito ha risposto con una pagina al posto dei dati: potrebbe essere cambiato o bloccare le richieste automatiche';
  }
  if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) {
    return `Risposta del sito diversa dal previsto (${name}: ${error.message}), forse il sito è cambiato: dettagli in ${log}`;
  }

  const message = error?.message || String(error || '');
  return message ? `Errore inatteso (${name}: ${message}), dettagli in ${log}` : `Errore inatteso (${name}), dettagli in ${log}`;
}

/** Italian text of an error, for the gui: what went wrong, where, and what to do */
function describe(error) {
  const text = explain(error);
  const where = error?.step;

  // Where it happened does not matter for a full disk or a missing internet
  if (!where || text === DISK_FULL_TEXT || text === OFFLINE_TEXT) return text;

  return `${where}: ${lowerFirst(text)}`;
}

/** The same text, after checking internet when the error comes from the network */
async function describeAsync(error) {
  if (isNetworkError(error)) await isOnline();
  return describe(error);
}

module.exports = {
  AppError, DownloadError, DiskFullError, SiteError, HttpError, RequestError,
  OFFLINE_TEXT, DISK_FULL_TEXT,
  isOnline, isNetworkError, waitOnline, sleep, getHost, describeNetwork, redirectedTo, describeResponse,
  isDiskFull, step, lowerFirst, explain, describe, describeAsync,
};
