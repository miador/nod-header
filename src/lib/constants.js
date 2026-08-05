export const APP_NAME = 'Nod Header';
export const STATE_KEY = 'state';
export const LOG_KEY = 'log';
export const SCHEMA_VERSION = 1;

/** Export file format identifier — also accepted on import. */
export const EXPORT_FORMAT = 'nod-header';
export const EXPORT_VERSION = 1;

/** Messages exchanged between the pages and the background worker. */
export const MSG = {
  GET_SNAPSHOT: 'get-snapshot',
  SET_STATE: 'set-state',
  SET_ENABLED: 'set-enabled',
  GET_LOG: 'get-log',
  CLEAR_LOG: 'clear-log',
  GET_DIAGNOSTICS: 'get-diagnostics',
};

/** DNR rule id ranges keep our generated rules from colliding with each other. */
export const RULE_ID_BASE = 1;
export const ALLOW_RULE_PRIORITY = 100;
export const MODIFY_RULE_PRIORITY = 1;

/** Every resource type declarativeNetRequest can match. */
export const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
];

/** Friendlier labels for the resource-type chips. */
export const RESOURCE_TYPE_LABELS = {
  main_frame: 'Page',
  sub_frame: 'Frame',
  stylesheet: 'CSS',
  script: 'Script',
  image: 'Image',
  font: 'Font',
  object: 'Object',
  xmlhttprequest: 'XHR / fetch',
  ping: 'Ping',
  csp_report: 'CSP report',
  media: 'Media',
  websocket: 'WebSocket',
  webtransport: 'WebTransport',
  webbundle: 'Web bundle',
  other: 'Other',
};

export const HEADER_TARGETS = ['request', 'response'];
export const HEADER_OPERATIONS = ['set', 'append', 'remove'];

/**
 * The header-name picker. Grouped so the dropdown reads as a short menu rather
 * than one long list. `Host` and the other browser-controlled names are left
 * out on purpose — offering a header the browser will refuse is a dead end.
 */
export const COMMON_HEADER_GROUPS = [
  {
    label: 'Authentication',
    headers: ['Authorization', 'Cookie', 'X-Api-Key', 'X-Auth-Token', 'X-CSRF-Token'],
  },
  {
    label: 'Content',
    headers: ['Content-Type', 'Content-Language', 'Content-Encoding', 'Content-Disposition',
      'Accept', 'Accept-Language', 'Accept-Encoding'],
  },
  {
    label: 'Request context',
    headers: ['User-Agent', 'Referer', 'Origin', 'Range', 'If-None-Match', 'If-Modified-Since'],
  },
  {
    label: 'Caching',
    headers: ['Cache-Control', 'Pragma', 'ETag', 'Expires'],
  },
  {
    label: 'CORS',
    headers: ['Access-Control-Allow-Origin', 'Access-Control-Allow-Headers',
      'Access-Control-Allow-Methods', 'Access-Control-Allow-Credentials',
      'Access-Control-Expose-Headers'],
  },
  {
    label: 'Security',
    headers: ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Frame-Options',
      'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy'],
  },
  {
    label: 'Tracing and debugging',
    headers: ['X-Request-Id', 'X-Correlation-Id', 'X-Trace-Id', 'X-Debug', 'Traceparent',
      'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP'],
  },
];

export const COMMON_HEADERS = COMMON_HEADER_GROUPS.flatMap((group) => group.headers);

/** Sentinel for the last item in the picker, which hands the field back to the user. */
export const CUSTOM_HEADER_OPTION = '__custom__';

/** Suggested values, offered as autocomplete once a name is chosen. Keys are lowercased. */
export const COMMON_HEADER_VALUES = {
  'authorization': ['Bearer ', 'Basic '],
  'content-type': ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data',
    'text/plain', 'text/html; charset=utf-8', 'application/xml'],
  'accept': ['application/json', '*/*', 'text/html', 'application/xml'],
  'accept-encoding': ['gzip, deflate, br', 'identity'],
  'accept-language': ['en-US,en;q=0.9', 'tr-TR,tr;q=0.9'],
  'cache-control': ['no-cache', 'no-store', 'max-age=0', 'public, max-age=31536000, immutable'],
  'pragma': ['no-cache'],
  'access-control-allow-origin': ['*', 'null'],
  'access-control-allow-credentials': ['true'],
  'access-control-allow-methods': ['GET, POST, PUT, PATCH, DELETE, OPTIONS'],
  'access-control-allow-headers': ['*', 'Authorization, Content-Type'],
  'x-content-type-options': ['nosniff'],
  'x-frame-options': ['DENY', 'SAMEORIGIN'],
  'referrer-policy': ['no-referrer', 'strict-origin-when-cross-origin', 'same-origin'],
  'strict-transport-security': ['max-age=31536000; includeSubDomains'],
  'content-security-policy': ["default-src 'self'"],
  'x-debug': ['true', 'false'],
  'x-forwarded-proto': ['https', 'http'],
};

/** Profile accent colours, used for the toolbar badge. */
export const PROFILE_COLORS = [
  '#1a74f2', '#0ea5a5', '#7c4dff', '#e0930d', '#d92d20', '#21ae45', '#e2557b', '#5b6b7f',
];

/**
 * Headers the browser will not let an extension change. Setting one is not an
 * error, it simply has no effect, so the UI warns instead of blocking.
 */
export const UNMODIFIABLE_HEADERS = [
  'content-length',
  'host',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'proxy-authorization',
  'trailer',
  'te',
];

/**
 * The only request headers Chrome accepts an append for. Any other name is a
 * parse-time rejection that fails the whole rule update, so an append outside
 * this list is dropped instead of submitted. Response headers have no such
 * restriction.
 */
export const APPENDABLE_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'access-control-request-headers',
  'cache-control',
  'connection',
  'content-language',
  'cookie',
  'forwarded',
  'if-match',
  'if-none-match',
  'keep-alive',
  'range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'want-digest',
  'x-forwarded-for',
];

export const MAX_PROFILES = 50;
export const MAX_HEADERS_PER_PROFILE = 200;
export const DEFAULT_LOG_LIMIT = 200;
export const MAX_LOG_LIMIT = 1000;
