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

## Quick Start with `.env.example`
1. Copy the example file and edit your values
   ```bash
   cp .env.example .env
   ```

2. Ensure `.env` is ignored by Git
   ```bash
   echo ".env" >> .gitignore
   ```

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
│ 0       │ 'upload no sse'       │ 100   │ 1127   │ 970   │ 1935  │ 3675  │
│ 1       │ 'upload sse aes256'   │ 100   │ 1058   │ 963   │ 1856  │ 2333  │
│ 2       │ 'download no sse'     │ 100   │ 526    │ 510   │ 787   │ 853   │
│ 3       │ 'download sse aes256' │ 100   │ 525    │ 483   │ 793   │ 1052  │
└─────────┴───────────────────────┴───────┴────────┴───────┴───────┴───────┘

Estimated mean overhead added by SSE AES256
┌─────────┬────────────┬──────────────┐
│ (index) │ operation  │ meanAddedMs  │
├─────────┼────────────┼──────────────┤
│ 0       │ 'upload'   │ 0            │
│ 1       │ 'download' │ 0            │
└─────────┴────────────┴──────────────┘

Paired delta SSE minus no-SSE (ms) with 95% CI
┌─────────┬────────────┬─────┬────────┬─────────┬──────────┐
│ (index) │ operation  │ n   │ meanMs │ ciLowMs │ ciHighMs │
├─────────┼────────────┼─────┼────────┼─────────┼──────────┤
│ 0       │ 'upload'   │ 100 │ -69    │ -260    │ 123      │
│ 1       │ 'download' │ 100 │ -1     │ -37     │ 35       │
└─────────┴────────────┴─────┴────────┴─────────┴──────────┘
```

## Interpreting Results
- **Raw timings:** Uploads and downloads with and without SSE are nearly identical across mean, median (p50), and tail latencies (p95, p99).
- **Estimated overhead:** The script reports `0 ms` overhead because differences are statistically insignificant. Negative or near-zero deltas mean there is no measurable overhead.
- **Confidence intervals:** If the 95% CI includes zero, there is no significant difference. Small negative values (SSE appearing slightly faster) are just noise.

### Plain-English Summary
Enabling SSE AES-256 on Backblaze B2 showed **no measurable performance impact**. Upload and download speeds were effectively the same with or without encryption.
