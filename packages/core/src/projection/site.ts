// URLs of the served tree (03 §3; 01 §4.6; 05 §4; ADR 0013). Every URL is the validated site base
// plus a path the 03 §3 path builders generate from IDs: run keys, PR numbers, stream IDs and
// hashes. Labels, claims and other capture data never reach a URL.
//
// The site location is trusted input (the forge's Pages metadata and config@1's prefix), and is
// still validated: HTTPS only, exactly the expected host, no port, userinfo, query, fragment,
// percent-encoding, backslash, empty or dot segment. The final URL is checked again, by pattern
// and by the WHATWG parser, so no normalization can move it.
import { blobPath } from "../blob-pool.ts";
import { API_INDEX, LLMS_TXT, SITE_JSON, changesPath, permalinkPath, prPointerPath, streamPath } from "../housekeeping/paths.ts";
import { refuse } from "./errors.ts";

export interface SiteLocation {
  /** The Pages site URL: `https://<owner>.github.io/<repo>/` for a project site, or a root or custom-domain site. */
  readonly pagesUrl: string;
  /** The host the site must be served from: `<owner>.github.io`, or the adopter's custom domain. */
  readonly expectedHost: string;
  /** config@1 `store.prefix` (a SitePrefix), default `pixelwatch`. */
  readonly prefix: string;
}

export const DEFAULT_PREFIX = "pixelwatch";
export const MAX_URL_LENGTH = 2048;

// Lowercase DNS name with at least two labels; the last starts with a letter, so no IP address.
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A path segment never starts with a dot, so "." and ".." can't occur, and holds no "%" or "\".
const SEGMENT = "[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,254}";
const PAGES_URL = new RegExp(`^https://([a-z0-9.-]{1,253})((?:/${SEGMENT})*)/?$`);
const PREFIX = /^[a-z0-9][a-z0-9_-]{0,63}(?:\/[a-z0-9][a-z0-9_-]{0,63}){0,3}$/;
const SERVED_PATH = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*/?$`);
// changes@1's HttpsUrl, without a port.
const FINAL_URL = new RegExp(`^https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?:/${SEGMENT})*/?$`);

function bad(message: string): never {
  return refuse("invalid-site", message);
}

/** The WHATWG parser must see exactly the URL we built: same text, host, no credentials or port. */
function checkParsed(url: string, host: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    bad("the URL doesn't parse");
  }
  if (
    parsed.href !== url ||
    parsed.protocol !== "https:" ||
    parsed.hostname !== host ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    bad("the URL doesn't survive parsing unchanged");
  }
}

/** A generated path, or a refusal: path builders throw RangeError for anything but a valid ID. */
function generated(build: () => string): string {
  try {
    return build();
  } catch (error) {
    if (error instanceof RangeError) bad(error.message);
    throw error;
  }
}

export class SiteUrls {
  /** The served tree's root, `<pagesUrl><prefix>/`. */
  readonly base: string;
  readonly host: string;
  readonly prefix: string;

  constructor(location: SiteLocation) {
    const { pagesUrl, expectedHost, prefix } = location;
    if (!HOST.test(expectedHost)) bad("the expected host must be a lowercase DNS name");
    if (pagesUrl.length > MAX_URL_LENGTH) bad("the Pages URL is longer than 2048 characters");
    const match = PAGES_URL.exec(pagesUrl);
    if (!match) bad("the Pages URL must be https://<host>/<path>/ with plain path segments and nothing else");
    const [, host = "", path = ""] = match;
    if (host !== expectedHost) bad("the Pages URL isn't on the expected host");
    if (!PREFIX.test(prefix)) bad("the prefix must be 1–4 lowercase ID segments");
    const site = `https://${host}${path}/`;
    checkParsed(site, host);
    this.host = host;
    this.prefix = prefix;
    this.base = this.check(`${site}${prefix}/`);
  }

  private check(url: string): string {
    if (url.length > MAX_URL_LENGTH || !FINAL_URL.test(url)) bad("the URL isn't a plain HTTPS URL");
    checkParsed(url, this.host);
    return url;
  }

  /** The absolute URL of a served path, relative to the prefix. The final URL is validated. */
  url(path: string): string {
    if (!SERVED_PATH.test(path)) bad("a served path is plain segments separated by '/'");
    return this.check(`${this.base}${path}`);
  }

  /** A canonical PNG: `blobs/<ab>/<pixelHash>.png`. */
  blob(pixelHash: string): string {
    return this.url(generated(() => blobPath(pixelHash)));
  }

  changes(runKey: string): string {
    return this.url(generated(() => changesPath(runKey)));
  }

  /** The run's permalink page, as its directory URL `runs/<runKey>/` (04 §1). */
  runPage(runKey: string): string {
    return this.url(generated(() => permalinkPath(runKey)).replace(/index\.html$/, ""));
  }

  prPointer(prNumber: string): string {
    return this.url(generated(() => prPointerPath(prNumber)));
  }

  stream(streamId: string): string {
    return this.url(generated(() => streamPath(streamId)));
  }

  apiIndex(): string {
    return this.url(API_INDEX);
  }

  siteJson(): string {
    return this.url(SITE_JSON);
  }

  llmsTxt(): string {
    return this.url(LLMS_TXT);
  }
}

export function siteUrls(location: SiteLocation): SiteUrls {
  return new SiteUrls(location);
}
