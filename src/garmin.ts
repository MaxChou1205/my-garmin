/**
 * Garmin Connect: login, token cache, .fit upload.
 *
 * Everything workerd-specific in here was established by the spike. See README §4
 * before touching any of it — each patch below fixes a real defect that only shows
 * up on workerd, and the failure modes are all misleading.
 */
import { GarminConnect } from "@flow-js/garmin-connect";

export interface GarminEnv {
  GARMIN_USERNAME: string;
  GARMIN_PASSWORD: string;
  GARMIN_CONSUMER_KEY: string;
  GARMIN_CONSUMER_SECRET: string;
  GARMIN_TOKENS: KVLike;
}

// ponytail: hand-rolled instead of pulling in @cloudflare/workers-types for one type.
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const TOKEN_KEY = "oauth2_access_token";
const UPLOAD_URL = "https://connectapi.garmin.com/upload-service/upload/.fit";

/**
 * The SSO login POST is built with the `form-data` package (a multipart stream)
 * but its header is overridden to application/x-www-form-urlencoded. On Node,
 * axios special-cases form-data streams and Garmin tolerates the mismatch; on
 * workerd there is no such special case, so the body goes out unparseable and
 * Garmin answers "Ticket not found or MFA" — which is not what went wrong.
 *
 * Re-encode that one request so the body matches its own Content-Type. _csrf is
 * scraped from the signin page the package just fetched, same regex the package uses.
 */
function fixSsoFormEncoding(gc: GarminConnect, username: string, password: string) {
  const client = gc.client as unknown as {
    get: (url: string, config?: unknown) => Promise<unknown>;
    post: (url: string, data: unknown, config?: unknown) => Promise<unknown>;
  };
  const get = client.get.bind(client);
  const post = client.post.bind(client);
  let signinHtml = "";

  client.get = async (url, config) => {
    const res = await get(url, config);
    if (url.includes("/sso/signin") && typeof res === "string") signinHtml = res;
    return res;
  };

  client.post = async (url, data, config) => {
    if (!url.includes("/sso/signin")) return post(url, data, config);

    const csrf = /name="_csrf"\s+value="(.+?)"/.exec(signinHtml)?.[1];
    if (!csrf) throw new Error("sso: no _csrf in the signin page — Garmin changed the login form");

    const body = new URLSearchParams({ username, password, embed: "true", _csrf: csrf }).toString();
    const headers = (config as { headers?: Record<string, unknown> })?.headers ?? {};
    return post(url, body, {
      ...(config as object),
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    });
  };
}

/**
 * The package does no cookie handling whatsoever — grep the whole dist for
 * "cookie" and you get nothing. Garmin's Spring Security binds _csrf to the
 * SESSION cookie set on the signin GET, so the login POST has to send it back.
 * On Node/Bun this happens to survive; workerd's fetch keeps no jar, which
 * matches the symptom exactly: valid CSRF, correct password, no ticket.
 */
function attachCookieJar(gc: GarminConnect) {
  const axios = (gc.client as unknown as { client: AxiosLike }).client;
  const jar = new Map<string, string>();

  axios.interceptors.request.use((config: AxiosConfig) => {
    if (jar.size) {
      config.headers = {
        ...(config.headers ?? {}),
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
      };
    }
    return config;
  });

  axios.interceptors.response.use(
    (res: AxiosResponse) => (harvest(jar, res), res),
    (err: { response?: AxiosResponse }) => (harvest(jar, err?.response), Promise.reject(err)),
  );
}

function harvest(jar: Map<string, string>, res?: AxiosResponse) {
  const raw = res?.headers?.["set-cookie"] as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const cookie of list) {
    const pair = String(cookie).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

type AxiosConfig = { headers?: Record<string, string> };
type AxiosResponse = { headers?: Record<string, string> };
type AxiosLike = {
  interceptors: {
    request: { use: (onOk: (c: AxiosConfig) => AxiosConfig) => void };
    response: { use: (onOk: (r: AxiosResponse) => unknown, onErr: (e: never) => unknown) => void };
  };
};

async function login(env: GarminEnv): Promise<string> {
  const gc = new GarminConnect({
    username: env.GARMIN_USERNAME,
    password: env.GARMIN_PASSWORD,
  });
  attachCookieJar(gc);
  fixSsoFormEncoding(gc, env.GARMIN_USERNAME, env.GARMIN_PASSWORD);

  // Never reach thegarth.s3.amazonaws.com at runtime: that bucket belongs to a
  // deprecated project and sits on the token hot path. The key is a public value.
  gc.client.OAUTH_CONSUMER = { key: env.GARMIN_CONSUMER_KEY, secret: env.GARMIN_CONSUMER_SECRET };
  gc.client.fetchOauthConsumer = async () => {};

  await gc.login();
  const oauth2 = gc.exportToken().oauth2;
  const token = oauth2?.access_token;
  if (!token) throw new Error("login returned no access token");

  // Expire our copy well before Garmin does so a normal upload never eats a 401.
  const ttl = Math.max(60, (oauth2.expires_in ?? 3600) - 600);
  await env.GARMIN_TOKENS.put(TOKEN_KEY, token, { expirationTtl: ttl });
  return token;
}

export async function accessToken(env: GarminEnv, force = false): Promise<string> {
  if (!force) {
    const cached = await env.GARMIN_TOKENS.get(TOKEN_KEY);
    if (cached) return cached;
  }
  return login(env);
}

/**
 * gc.uploadActivity() is unusable on workerd: it builds the body with the Node
 * `form-data` package, which bundles to a browser shim with no getHeaders(), and
 * it reads the file via fs.createReadStream from a path. The upload is a single
 * authenticated POST, so issue it directly.
 *
 * Native FormData sets its own multipart boundary — never set Content-Type by
 * hand here or the boundary won't match the body.
 */
async function post(token: string, fit: Uint8Array, filename: string) {
  const form = new FormData();
  form.append("userfile", new Blob([fit]), filename);
  return fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

export interface UploadResult {
  duplicate: boolean;
  activityId?: number;
}

export async function uploadFit(
  env: GarminEnv,
  fit: Uint8Array,
  filename: string,
): Promise<UploadResult> {
  // A .fit file carries the ASCII magic ".FIT" at offset 8. Checking it here turns
  // "that wasn't really a fit file" into a clear message instead of an opaque 415.
  if (new TextDecoder().decode(fit.subarray(8, 12)) !== ".FIT") {
    throw new Error("這不是有效的 .fit 檔（offset 8 沒有 .FIT 標記）");
  }

  // A cached token can die early — Garmin invalidates everything on a password
  // change. One forced re-login covers that; more retries would just hammer SSO.
  let res = await post(await accessToken(env), fit, filename);
  if (res.status === 401) res = await post(await accessToken(env, true), fit, filename);

  const text = await res.text();
  if (res.status === 409) return { duplicate: true };
  if (!res.ok) throw new Error(`Garmin 回 ${res.status}: ${text.slice(0, 500)}`);

  let activityId: number | undefined;
  try {
    activityId = JSON.parse(text)?.detailedImportResult?.successes?.[0]?.internalId;
  } catch {
    // Garmin sometimes answers HTML on success paths too; the upload still worked.
  }
  return { duplicate: false, activityId };
}
