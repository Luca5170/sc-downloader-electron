// 10.12.23

const cheerio = require('cheerio');
const http = require('../util/http');
const { getHeaders } = require('../util/headers');
const { SiteError, redirectedTo } = require('../util/errors');

const SITE_NAME = 'streamingcommunityz';     // Used when only the extension is given

/**
 * Full address of the site, from what the user writes: a whole domain (streamingcommunityz.shiksha, a new name),
 * a pasted link, or only the extension (shiksha) as the old versions saved it
 */
function getHost(domain) {
  let host = String(domain || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#]/)[0].replace(/^\.+|\.+$/g, '');
  host = host.startsWith('www.') ? host.slice(4) : host;

  return host.includes('.') || !host ? host : `${SITE_NAME}.${host}`;
}

function getSiteUrl(domain) {
  return `https://${getHost(domain)}`;
}

function getBaseUrl(domain) {
  return `${getSiteUrl(domain)}/it`;
}

/** Inertia version of the site, the errors say why the domain does not work */
async function getVersion(domain) {
  const site = getHost(domain);
  const response = (await http.get(getSiteUrl(domain), { headers: { 'user-agent': getHeaders() }, timeout: 15, retries: 0 })).raiseForStatus();
  const page = cheerio.load(response.text)('div#app').attr('data-page');

  if (!page) {
    // A domain that is no more of the site often sends to another one
    const moved = redirectedTo(response);
    if (moved) throw new SiteError(`${site} rimanda a ${moved}, che non è il sito: l'indirizzo è cambiato o il provider blocca il sito`);
    throw new SiteError(`${site} risponde, ma non con la pagina del sito: l'indirizzo potrebbe essere cambiato o il provider blocca il sito`);
  }

  try {
    const version = JSON.parse(page).version;
    if (version === undefined || version === null) throw new Error('version');
    return version;
  } catch {
    throw new SiteError(`La pagina di ${site} è cambiata: il programma non trova la versione del sito`);
  }
}

/** Make inertia req to a page of the site and return its props, raise if it fails */
async function getPageProps(url, version, params = null, headers = null) {
  const response = await http.get(url, {
    params,
    timeout: 15,
    retries: 0,
    headers: { 'user-agent': getHeaders(), 'x-inertia': 'true', 'x-inertia-version': String(version), ...(headers || {}) },
  });

  return response.raiseForStatus().json().props;
}

function getHome(domain, version) {
  return getPageProps(getBaseUrl(domain), version);
}

function getSearch(titleSearch, domain, version) {
  return getPageProps(`${getBaseUrl(domain)}/search`, version, { q: titleSearch });
}

function getTitle(titleId, slug, domain, version) {
  return getPageProps(`${getBaseUrl(domain)}/titles/${titleId}-${slug}`, version);
}

module.exports = { SITE_NAME, getHost, getSiteUrl, getBaseUrl, getVersion, getPageProps, getHome, getSearch, getTitle };
