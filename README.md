# sse-overhead.mjs

Benchmark tool to measure the latency impact of **Server-Side Encryption (AES-256)** on Backblaze B2’s S3-compatible API.

## Overview
This script uploads and downloads random test objects with and without SSE enabled, records performance metrics, and reports whether encryption adds measurable latency.

## Features
- Upload and download objects to B2 with and without SSE (AES256)
- Records latency statistics (mean, p50, p95, p99)
- Estimates mean overhead added by SSE
- Paired delta with 95% confidence interval (CI)
- Configurable payload size, iterations, retries, and logging
- Cleans up all test objects automatically

## Requirements
- Node.js 18+
- NPM packages: `aws4fetch`, `undici`, `dotenv`
- A Backblaze B2 account with an application key and bucket

## Installation
```bash
npm install aws4fetch undici dotenv
```

## Environment Variables
Set in `.env` file or environment:

- `B2_ACCESS_KEY_ID` – your key ID  
- `B2_SECRET_ACCESS_KEY` – your application key  
- `B2_BUCKET` – target bucket name  
- `B2_ENDPOINT` – optional, default `https://s3.us-east-005.backblazeb2.com`  
- `TEST_KEY` – optional base key name, default `meta-test.txt`

## Usage
```bash
node sse-overhead.mjs [options]
```

### Options
- `--sizeMB <num>`        Test payload size in MB (default 8)  
- `--iterations <num>`    Number of iterations (default 5)  
- `--download true|false` Include GET timing (default true)  
- `--prefix <string>`     Key prefix (default sse-overhead)  
- `--retries <num>`       Max retries per request (default 5)  
- `--baseDelayMs <num>`   Base backoff delay in ms (default 150)  
- `--verbose true|false`  Toggle detailed logs (default true)  

### Example
```bash
node sse-overhead.mjs --sizeMB 16 --iterations 50 --download true
```

## Sample Output
```
Results ms
┌─────────┬───────────────────────┬───────┬────────┬───────┬───────┬───────┐
│ (index) │ name                  │ count │ meanMs │ p50Ms │ p95Ms │ p99Ms │
├─────────┼───────────────────────┼───────┼────────┼───────┼───────┼───────┤
│ 0       │ upload no sse         │   50  │   520  │  512  │  610  │  645  │
│ 1       │ upload sse aes256     │   50  │   524  │  514  │  615  │  652  │
│ 2       │ download no sse       │   50  │   490  │  485  │  550  │  580  │
│ 3       │ download sse aes256   │   50  │   491  │  486  │  552  │  581  │
└─────────┴───────────────────────┴───────┴────────┴───────┴───────┴───────┘

Estimated mean overhead added by SSE AES256
┌─────────┬────────────┬──────────────┐
│ (index) │ operation  │ meanAddedMs  │
├─────────┼────────────┼──────────────┤
│ 0       │ upload     │ 4            │
│ 1       │ download   │ 1            │
└─────────┴────────────┴──────────────┘
```

## Notes
- Negative or near-zero deltas mean no measurable overhead from SSE.  
- If the 95% CI includes zero, the test does not show a significant difference.  
- This test deletes all objects it creates. Do not run on production prefixes.
