/**
 * Export every Garmin activity's original .fit into a folder, ready for a manual
 * upload to Strava (or anywhere else). Reuses src/garmin.ts for login.
 *
 *   bun --env-file=.dev.vars src/export.ts [outDir=export]
 *
 * Resumable: files already on disk are skipped, so after an interruption or a
 * Garmin hiccup you just run it again.
 */
import { existsSync, mkdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { accessToken, type GarminEnv, type KVLike } from "./garmin";

const GC = "https://connectapi.garmin.com";
const outDir = process.argv[2] ?? "export";

// Token lives in a gitignored file so re-runs don't log in again: Garmin answers
// repeated logins with 429 for hours. No expiry tracking — a dead token gets a 401,
// which garmin() below turns into one forced re-login.
const TOKEN_FILE = ".garmin-token";
const kv: KVLike = {
  get: async () =>
    existsSync(TOKEN_FILE) ? (await Bun.file(TOKEN_FILE).text()).trim() || null : null,
  put: async (_k, v) => void (await Bun.write(TOKEN_FILE, v)),
};
const env = { ...process.env, GARMIN_TOKENS: kv } as unknown as GarminEnv;
if (!env.GARMIN_USERNAME || !env.GARMIN_PASSWORD) {
  throw new Error("missing creds — run with: bun --env-file=.dev.vars");
}
// Same snapshot as wrangler.toml [vars], which aren't in .dev.vars.
env.GARMIN_CONSUMER_KEY ||= "fc3e99d2-118c-44b8-8ae3-03370dde24c0";
env.GARMIN_CONSUMER_SECRET ||= "E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF";

async function garmin(path: string): Promise<Response> {
  const get = async (force: boolean) =>
    fetch(GC + path, { headers: { Authorization: `Bearer ${await accessToken(env, force)}` } });
  let res = await get(false);
  if (res.status === 401) res = await get(true);
  return res;
}

/**
 * Garmin serves the original file as a zip with a single entry. Read the central
 * directory, because the local header's sizes can be zero when the zip uses a data
 * descriptor. Only stored (0) and deflate (8) exist in practice.
 */
function unzipFirst(zip: Uint8Array): Uint8Array {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const cd = v.getUint32(eocd + 16, true);
  const method = v.getUint16(cd + 10, true);
  const size = v.getUint32(cd + 20, true);
  const local = v.getUint32(cd + 42, true);
  const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
  const data = zip.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return new Uint8Array(inflateRawSync(data));
  throw new Error(`zip method ${method} not supported`);
}

type Activity = { activityId: number; activityName: string; startTimeLocal: string };

// Page through the whole history. 100 per page keeps each response small.
const all: Activity[] = [];
for (let start = 0; ; start += 100) {
  const res = await garmin(
    `/activitylist-service/activities/search/activities?start=${start}&limit=100`,
  );
  if (!res.ok) throw new Error(`Garmin list ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const page = (await res.json()) as Activity[];
  all.push(...page);
  if (page.length < 100) break;
}
console.log(`共 ${all.length} 筆活動 → ${outDir}/`);
mkdirSync(outDir, { recursive: true });

let saved = 0,
  skipped = 0;
const failed: string[] = [];
for (const [i, a] of all.entries()) {
  // "2026-09-30 07:12:33" → "2026-09-30_0712_<id>.fit": sorts by date, unique by id.
  const name = `${a.startTimeLocal.slice(0, 16).replace(" ", "_").replace(":", "")}_${a.activityId}.fit`;
  const path = `${outDir}/${name}`;
  const label = `[${i + 1}/${all.length}] ${name} ${a.activityName ?? ""}`;
  if (existsSync(path)) {
    skipped++;
    continue;
  }
  try {
    const res = await garmin(`/download-service/files/activity/${a.activityId}`);
    // Manual entries have no original file to download.
    if (!res.ok) throw new Error(`Garmin 下載 ${res.status}`);
    const fit = unzipFirst(new Uint8Array(await res.arrayBuffer()));
    if (new TextDecoder().decode(fit.subarray(8, 12)) !== ".FIT")
      throw new Error("原始檔不是 .fit");
    await Bun.write(path, fit);
    saved++;
    console.log(label, "✅");
    // ponytail: fixed pause, no backoff. Failed ones are retried by simply re-running.
    await Bun.sleep(500);
  } catch (e) {
    // Keep going: one bad activity shouldn't block the rest of the history.
    failed.push(`${label} ❌ ${(e as Error).message}`);
    console.log(label, `❌ ${(e as Error).message}`);
  }
}

console.log(`\n完成：新下載 ${saved}、已存在跳過 ${skipped}、失敗 ${failed.length}`);
if (failed.length) console.log(failed.join("\n"));
