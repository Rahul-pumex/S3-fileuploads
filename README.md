# S3 Files by Date API (Node.js + Express)

This project exposes an API endpoint that downloads a CSV of S3 object keys and upload times (`LastModified`) within a given date range.

## 1) Setup

1. Install dependencies:
   - `npm install`
2. Create `.env` from example:

3. Fill AWS and bucket values in `.env`.

## 2) Run

- Development: `npm run dev`
- Normal run: `npm start`

Server starts on `http://localhost:3000` (or your `PORT` value).

## 3) Swagger

Interactive docs: **`GET /api-docs`** (Swagger UI).

OpenAPI spec source: `openapi.json`.

## 4) Endpoints

### Health

`GET /health`

Response:

- `{ "status": "ok" }`

### Download files by date range (CSV)

`GET /files?startDate=2026-04-01&endDate=2026-04-30`

Optional query:

- `folderName` — S3 key prefix (folder). Omit to scan the whole bucket (still filtered by date).

Examples:

- Whole bucket, April 2026:  
  `GET /files?startDate=2026-04-01&endDate=2026-04-30`
- One folder:  
  `GET /files?startDate=2026-04-01&endDate=2026-04-30&folderName=invoices/april`

**Date behavior**

- `startDate` / `endDate` accept ISO strings.
- If **`endDate` has no time part** (no `T` in the value), it is treated as **end of that calendar day in UTC** (`23:59:59.999Z`), so `endDate=2026-04-30` includes objects on April 30 for typical UTC-day semantics.

**Range limit**

- Default maximum span: **365 days** (`startDate` → `endDate`). Override with env **`MAX_RANGE_DAYS`**.

A successful call returns **`text/csv`** with `Content-Disposition: attachment` (UTF-8 with BOM for Excel). The download has a header row and one data row per object whose `LastModified` falls in the range.

- Columns: `fileName`, `uploadedAt` (ISO-8601).
- **Errors** (400, 500) are still **JSON** for easy debugging in Swagger or clients.

### Preview files by date range (JSON)

`GET /files/preview?startDate=2026-04-01&endDate=2026-04-30`

- Uses the same filters and validation as `/files`.
- Returns the previous JSON response with:
  - `bucket`, `folderPrefix`, `dateRange`
  - `s3ObjectsListed`, `count`
  - `files[]`

Use this endpoint in Swagger when you want to inspect records directly in the response body.

**Logging**

- Each successful `/files` call logs: bucket, folder, `s3ObjectsListed`, `matchedInDateRange`, and effective start/end.

## 5) AWS Permissions

The IAM user/role in `.env` should have at least:

- `s3:ListBucket` on the target bucket

## 6) Notes

- S3 exposes last modification time as `LastModified`, not a separate “upload only” field.
- Listing large prefixes still paginates through S3; use `folderName` when possible to reduce work.
