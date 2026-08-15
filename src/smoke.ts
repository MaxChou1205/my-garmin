/**
 * The one runnable check: does login + upload still work against the real Garmin?
 * Runs the exact production code path, just off workerd.
 *
 *   bun --env-file=.dev.vars src/smoke.ts path/to/activity.fit
 *
 * Uploading twice is the real assertion: the first run imports, the second must
 * come back as a duplicate. If Garmin changes its login HTML, this fails loudly
 * here instead of silently in the bot.
 */
import { uploadFit, type GarminEnv, type KVLike } from "./garmin";

const path = process.argv[2];
if (!path) throw new Error("usage: bun --env-file=.dev.vars src/smoke.ts <file.fit>");

const mem = new Map<string, string>();
const kv: KVLike = {
  async get(k) {
    return mem.get(k) ?? null;
  },
  async put(k, v) {
    mem.set(k, v);
  },
};

const env = { ...process.env, GARMIN_TOKENS: kv } as unknown as GarminEnv;
if (!env.GARMIN_USERNAME || !env.GARMIN_PASSWORD) {
  throw new Error("missing creds — run with: bun --env-file=.dev.vars");
}
// wrangler.toml [vars] aren't in .dev.vars; mirror the snapshot for this run.
env.GARMIN_CONSUMER_KEY ||= "fc3e99d2-118c-44b8-8ae3-03370dde24c0";
env.GARMIN_CONSUMER_SECRET ||= "E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF";

const fit = new Uint8Array(await Bun.file(path).arrayBuffer());
const name = path.split(/[\\/]/).pop()!;

const first = await uploadFit(env, fit, name);
console.log("upload 1:", first, `(cached token: ${mem.size > 0})`);

const second = await uploadFit(env, fit, name);
console.assert(second.duplicate, "second upload of the same file should be a duplicate");
console.log("upload 2:", second);
console.log(second.duplicate ? "smoke ok" : "SMOKE FAILED: no duplicate on re-upload");
