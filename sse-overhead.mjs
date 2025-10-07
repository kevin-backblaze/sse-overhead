// sse-overhead.mjs

/**
 * Measure the latency impact of enabling Server-Side Encryption (SSE AES-256)
 * on Backblaze B2 via its S3-compatible API.
 *
 * What it does
 * 1) Generates a random payload of configurable size
 * 2) For each iteration:
 *      - PUT without SSE and time it
 *      - PUT with SSE AES256 and time it
 *      - Optionally GET both objects and time them
 *      - DELETE both objects
 * 3) Prints:
 *      - Summary stats mean p50 p95 p99 for upload and download
 *      - Estimated mean overhead added by SSE
 *      - Paired delta table with 95% CI for SSE minus no-SSE
 *
 * Usage
 *   Environment:
 *     B2_ACCESS_KEY_ID, B2_SECRET_ACCESS_KEY, B2_BUCKET
 *     B2_ENDPOINT optional, default https://s3.us-east-005.backblazeb2.com
 *     TEST_KEY optional base key name, default meta-test.txt
 *
 *   CLI flags:
 *     --sizeMB <num>        test payload size in MB (default 8)
 *     --iterations <num>    number of pairs to run (default 5)
 *     --download true|false include GET timing (default true)
 *     --prefix <string>     key prefix for objects (default sse-overhead)
 *     --verbose true|false  progress logs (default true)
 *     --retries <num>       max automatic retries per request (default 5)
 *     --baseDelayMs <num>   base backoff step in ms (default 150)
 *
 * Notes
 * - Uses a keep-alive HTTP agent to reduce connection setup overhead
 * - Retries with jittered exponential backoff on 5xx, 429, and common network errors
 * - Deletes all test objects it creates
 */

import { AwsClient } from "aws4fetch";
import "dotenv/config";
import crypto from "crypto";
import { performance } from "node:perf_hooks";
import { argv } from "node:process";
import { setGlobalDispatcher, Agent } from "undici";

// Keep-alive HTTP agent to reduce TCP resets
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 10
}));

// Env from your .env
const ACCESS = process.env.B2_ACCESS_KEY_ID;
const SECRET = process.env.B2_SECRET_ACCESS_KEY;
const ENDPOINT = (process.env.B2_ENDPOINT || "https://s3.us-east-005.backblazeb2.com").replace(/\/+$/, "");
const BUCKET = process.env.B2_BUCKET;
const TEST_KEY = process.env.TEST_KEY || "meta-test.txt";

// Backblaze S3-compatible signing region
const REGION = "us-east-005";

// Signer
const s3 = new AwsClient({
  accessKeyId: ACCESS,
  secretAccessKey: SECRET,
  service: "s3",
  region: REGION
});

/**
 * Parse simple --flag value CLI args with defaults.
 * @returns {{sizeMB:number, iterations:number, download:boolean, prefix:string, verbose:boolean, maxRetries:number, baseDelayMs:number}}
 */
function parseArgs() {
  const get = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : def;
  };
  return {
    sizeMB: Number(get("sizeMB", "8")),
    iterations: Number(get("iterations", "5")),
    download: get("download", "true") !== "false",
    prefix: get("prefix", "sse-overhead"),
    verbose: get("verbose", "true") !== "false",
    maxRetries: Number(get("retries", "5")),
    baseDelayMs: Number(get("baseDelayMs", "150"))
  };
}
const cfg = parseArgs();
const log = (...a) => { if (cfg.verbose) console.log(...a); };

/**
 * Build a properly encoded S3 URL for a given key within the configured bucket.
 * @param {string} key
 * @returns {string} fully-qualified URL
 */
function urlFor(key) {
  const safeBucket = encodeURIComponent(BUCKET);
  const safeKey = key.split("/").map(encodeURIComponent).join("/");
  return `${ENDPOINT}/${safeBucket}/${safeKey}`;
}

/**
 * Compute simple summary statistics for an array of millisecond timings.
 * Returns rounded mean and quantiles p50, p95, p99.
 * @param {string} name label for the row
 * @param {number[]} arr timings in milliseconds
 * @returns {{name:string,count:number,meanMs:number,p50Ms:number,p95Ms:number,p99Ms:number}}
 */
function summary(name, arr) {
  if (!arr.length) return { name, count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const q = p => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return { name, count: n, meanMs: Math.round(mean), p50Ms: Math.round(q(0.5)), p95Ms: Math.round(q(0.95)), p99Ms: Math.round(q(0.99)) };
}

/** Sleep helper */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Decide whether a request should be retried based on error/response.
 * Retries network errors, HTTP 5xx, and 429.
 * @param {Error|undefined} err
 * @param {Response|undefined} res
 * @returns {boolean}
 */
function shouldRetry(err, res) {
  if (err) return true;                // network errors (ECONNRESET, ETIMEDOUT, etc.)
  if (!res) return true;
  if (res.status >= 500) return true;  // 5xx
  if (res.status === 429) return true; // throttled
  return false;
}

/**
 * Jittered exponential backoff delay in ms with a soft cap.
 * @param {number} attempt zero-based attempt index
 * @param {number} base base delay in ms
 * @returns {number} delay in milliseconds
 */
function backoffDelay(attempt, base) {
  const cap = 2000;
  const exp = Math.min(cap, base * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * base);
  return exp + jitter;
}

/**
 * Centralized signed fetch with retries and helpful error messages.
 * Uses aws4fetch signer and undici agent configured above.
 * @param {string} url
 * @param {RequestInit} options
 * @param {string} label for logs and errors
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, label) {
  let lastErr, lastRes;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const res = await s3.fetch(url, options);
      if (!res.ok && shouldRetry(null, res)) {
        lastRes = res;
        const d = backoffDelay(attempt, cfg.baseDelayMs);
        log(`Retry ${label} (HTTP ${res.status}) in ${d}ms`);
        await sleep(d);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      const d = backoffDelay(attempt, cfg.baseDelayMs);
      log(`Retry ${label} (${err?.cause?.code || err?.message || err}) in ${d}ms`);
      await sleep(d);
    }
  }
  if (lastErr) {
    const extra = lastErr?.cause ? ` cause: ${lastErr.cause.code || ""} ${lastErr.cause.message || ""}` : "";
    throw new Error(`${label} failed after retries: ${lastErr.message || lastErr}${extra}`);
  }
  if (lastRes) {
    const body = await lastRes.text().catch(() => "");
    throw new Error(`${label} failed after retries: ${lastRes.status} ${lastRes.statusText} ${body}`);
  }
  throw new Error(`${label} failed after retries`);
}

/**
 * PUT an object to B2 S3 and measure elapsed time.
 * Adds x-amz-server-side-encryption: AES256 when useSSE is true.
 * @param {string} key
 * @param {Buffer|Uint8Array} body
 * @param {boolean} useSSE
 * @returns {Promise<number>} elapsed milliseconds
 */
async function putObject(key, body, useSSE) {
  const headers = {
    "content-type": "application/octet-stream",
    "content-length": String(body.length),
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD"
  };
  if (useSSE) headers["x-amz-server-side-encryption"] = "AES256";

  const t0 = performance.now();
  const res = await fetchWithRetry(urlFor(key), { method: "PUT", body, headers }, `PUT ${key}`);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PUT ${key} failed ${res.status} ${res.statusText} ${txt}`);
  }
  return performance.now() - t0;
}

/**
 * GET an object from B2 S3 and measure elapsed time.
 * Drains the response body to time the full transfer.
 * @param {string} key
 * @returns {Promise<number>} elapsed milliseconds
 */
async function getObject(key) {
  const t0 = performance.now();
  const res = await fetchWithRetry(urlFor(key), { method: "GET" }, `GET ${key}`);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`GET ${key} failed ${res.status} ${res.statusText} ${txt}`);
  }
  await res.arrayBuffer(); // drain for full timing
  return performance.now() - t0;
}

/**
 * DELETE an object. Ignores 404.
 * @param {string} key
 * @returns {Promise<void>}
 */
async function deleteObject(key) {
  const res = await fetchWithRetry(urlFor(key), { method: "DELETE" }, `DELETE ${key}`);
  if (!res.ok && res.status !== 404) {
    const txt = await res.text().catch(() => "");
    throw new Error(`DELETE ${key} failed ${res.status} ${res.statusText} ${txt}`);
  }
}

/**
 * Compute a normal-approx 95 percent CI for an array of numbers.
 * @param {number[]} arr
 * @returns {{n:number, mean:number, low:number, high:number}}
 */
function ci95(arr) {
  const n = arr.length;
  if (!n) return { n: 0, mean: 0, low: 0, high: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1 || 1);
  const se = Math.sqrt(variance / n);
  const margin = 1.96 * se;
  return { n, mean, low: mean - margin, high: mean + margin };
}

/**
 * Program entry point. Validates env, pings the bucket, generates payload,
 * executes iterations of PUT/GET/DELETE with and without SSE, and prints results.
 */
async function main() {
  if (!ACCESS || !SECRET || !BUCKET) {
    console.error("Missing env. Require B2_ACCESS_KEY_ID B2_SECRET_ACCESS_KEY B2_BUCKET and optional B2_ENDPOINT TEST_KEY");
    process.exit(1);
  }

  // Connectivity check: ListObjectsV2 with max-keys=0
  const listUrl = `${ENDPOINT}/${encodeURIComponent(BUCKET)}/?list-type=2&max-keys=0`;
  const ping = await fetchWithRetry(listUrl, { method: "GET" }, "LIST ping");
  if (!ping.ok) {
    const body = await ping.text().catch(() => "");
    throw new Error(`Bucket check failed ${ping.status} ${ping.statusText} ${body}`);
  }

  const sizeBytes = Math.max(1, Math.floor(cfg.sizeMB * 1024 * 1024));
  const payload = crypto.randomBytes(sizeBytes);

  console.log(`Endpoint ${ENDPOINT}`);
  console.log(`Bucket   ${BUCKET}`);
  console.log(`Key base ${TEST_KEY}`);
  console.log(`Size     ${cfg.sizeMB} MB  Iterations ${cfg.iterations}  Download ${cfg.download}\n`);

  const upNo = [], upSSE = [], dnNo = [], dnSSE = [];

  for (let i = 0; i < cfg.iterations; i++) {
    const base = `${cfg.prefix}/${TEST_KEY}-${Date.now()}-${i}-${crypto.randomBytes(3).toString("hex")}`;
    const keyNo = `${base}-nosse.bin`;
    const keyS = `${base}-sse.bin`;

    log(`PUT no SSE -> ${keyNo}`);
    upNo.push(await putObject(keyNo, payload, false));

    log(`PUT SSE AES256 -> ${keyS}`);
    upSSE.push(await putObject(keyS, payload, true));

    if (cfg.download) {
      log(`GET no SSE <- ${keyNo}`);
      dnNo.push(await getObject(keyNo));

      log(`GET SSE AES256 <- ${keyS}`);
      dnSSE.push(await getObject(keyS));
    }

    log(`DELETE ${keyNo} and ${keyS}`);
    await deleteObject(keyNo);
    await deleteObject(keyS);

    // tiny pause reduces back-to-back contention when testing over flaky links
    await sleep(50);
  }

  const sUpNo = summary("upload no sse", upNo);
  const sUpS = summary("upload sse aes256", upSSE);
  const sDnNo = summary("download no sse", dnNo);
  const sDnS = summary("download sse aes256", dnSSE);
  const added = (a, b) => Math.max(0, Math.round(b.meanMs - a.meanMs));

  console.log("\nResults ms");
  console.table([sUpNo, sUpS, sDnNo, sDnS]);

  console.log("\nEstimated mean overhead added by SSE AES256");
  console.table([
    { operation: "upload", meanAddedMs: added(sUpNo, sUpS) },
    { operation: "download", meanAddedMs: added(sDnNo, sDnS) }
  ]);

  // Paired-delta 95% CI (SSE minus no-SSE per iteration)
  const upPairs = upSSE.map((v, i) => v - upNo[i]).filter(Number.isFinite);
  const dnPairs = dnSSE.map((v, i) => v - dnNo[i]).filter(Number.isFinite);
  const upCI = ci95(upPairs);
  const dnCI = ci95(dnPairs);

  console.log("\nPaired delta SSE minus no-SSE (ms) with 95% CI");
  console.table([
    { operation: "upload", n: upCI.n, meanMs: Math.round(upCI.mean), ciLowMs: Math.round(upCI.low), ciHighMs: Math.round(upCI.high) },
    { operation: "download", n: dnCI.n, meanMs: Math.round(dnCI.mean), ciLowMs: Math.round(dnCI.low), ciHighMs: Math.round(dnCI.high) }
  ]);
}

// Top-level run with fatal error handling
main().catch(err => {
  const extra = err?.cause ? ` cause: ${err.cause.code || ""} ${err.cause.message || ""}` : "";
  console.error(`Fatal: ${err?.message || err}${extra}`);
  process.exit(1);
});
