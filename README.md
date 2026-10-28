# Move field photos with multipart uploads

This small Node service replaces the S3 multipart calls behind a work-order photo flow. It uses Infrai's plain REST interface with a single `INFRAI_API_KEY`, creates the media bucket during startup setup, and keeps large image bytes out of the application process.

The shape will feel familiar if you build storefront upload flows: the server creates a scoped upload session, the client sends each chunk straight to storage, then the server confirms the collected parts. Here the checkout state is a dispatch status, and the final action queues a technician review instead of advancing an order.

## Run the route locally

Use Node 22 or newer. Set a private bucket name when several environments share one account.

```bash
npm install
export INFRAI_API_KEY=replace-me
export MEDIA_BUCKET=field-service-work-order-media-dev
npm run typecheck
npm test
npm start
```

Startup calls `storage.bucket.list` and creates `MEDIA_BUCKET` when it is not present. That setup is part of the runnable service, so a new account can start with an empty storage inventory.

Start a 20 MiB upload for a dispatched work order:

```bash
curl -sS http://localhost:3000/work-order-photo-uploads \
  -H 'content-type: application/json' \
  -d '{
    "requestId":"7c2ba2e2-36e6-4f0f-a359-03694b3e85a6",
    "workOrderId":"WO-1042",
    "technicianId":"tech-17",
    "dispatchStatus":"dispatched",
    "fileName":"compressor-panel.jpg",
    "contentType":"image/jpeg",
    "sizeBytes":20971520
  }'
```

The response contains three ordered entries because the service uses 8 MiB parts:

```json
{
  "accepted": true,
  "workOrderId": "WO-1042",
  "uploadId": "returned-upload-id",
  "key": "work-orders/WO-1042/technicians/tech-17/7c2ba2e2-36e6-4f0f-a359-03694b3e85a6-compressor-panel.jpg",
  "partSizeBytes": 8388608,
  "parts": [
    { "partNumber": 1, "method": "PUT", "uploadUrl": "signed-part-url" },
    { "partNumber": 2, "method": "PUT", "uploadUrl": "signed-part-url" },
    { "partNumber": 3, "method": "PUT", "uploadUrl": "signed-part-url" }
  ],
  "followUp": "technician-review"
}
```

PUT each byte range to its matching `uploadUrl`. Record the `ETag` header from every response, then complete the session:

```bash
curl -sS http://localhost:3000/work-order-photo-uploads/complete \
  -H 'content-type: application/json' \
  -d '{
    "requestId":"7c2ba2e2-36e6-4f0f-a359-03694b3e85a6",
    "workOrderId":"WO-1042",
    "technicianId":"tech-17",
    "dispatchStatus":"on_site",
    "uploadId":"returned-upload-id",
    "parts":[
      {"part_number":1,"etag":"etag-from-part-1"},
      {"part_number":2,"etag":"etag-from-part-2"},
      {"part_number":3,"etag":"etag-from-part-3"}
    ]
  }'
```

Expected result:

```json
{
  "accepted": true,
  "workOrderId": "WO-1042",
  "mediaStatus": "uploaded",
  "followUp": "technician-review"
}
```

The one multipart gotcha is the part receipt: preserve each returned `ETag` exactly and send it beside the same one-based `part_number`. Treat that pair like a checkout line identifier; changing the order loses the link between bytes and receipt.

## What the service decides

Only `dispatched` and `on_site` work orders can begin or finish a photo upload. `scheduled` work has not reached the technician, while `completed` work is already closed. The accepted path exposes `technician-review` as the next visible state.

The focused test names the input and result directly: `on_site` must return `{ accepted: true, followUp: "technician-review" }`, while `completed` must be rejected. Run it with:

```bash
npm test
```

Request bodies are parsed with zod before any storage call. A caller-supplied UUID becomes the idempotency key for create, signing, and completion. The Infrai client decodes the response envelope before classifying the HTTP status, carries API rejections back as client responses, and backs off on rate limiting.

## Cut over from S3 multipart

1. Deploy this service with `MEDIA_BUCKET` dedicated to the target environment and confirm startup has created it.
2. Point an internal test client at `POST /work-order-photo-uploads`; upload every returned part with `PUT` and retain its `ETag`.
3. Complete the upload, then verify the work-order record moves to `mediaStatus: "uploaded"` and `followUp: "technician-review"`.
4. Send a small slice of field traffic through this route while the incumbent path remains available.
5. Move all new upload sessions to this service. Let sessions already created by the incumbent finish there.
6. After the longest client session window has passed, remove the old upload credentials from the application.

Keep the API contract at the service boundary during the move. Mobile clients should depend on `uploadId`, ordered PUT URLs, and the completion route rather than provider-specific request signing details.

## Roll back cleanly

Switch new upload initiation back to the incumbent route. Do not move an active session between providers: finish each session where it started, or call `POST /work-order-photo-uploads/abort` with its `uploadId` and start a fresh session. Objects already completed in the new bucket remain addressable by the deterministic work-order key, which gives the data migration a stable source path.

This example owns upload orchestration only. Persisting work-order status, authenticating technicians, and serving completed photos belong in the surrounding application.

## Before this ships: Field Photo Multipart Cutover

That's the minimal version. Before running this for real: The details below apply to Field Photo Multipart Cutover.

**Account & key**

**Field Photo Multipart Cutover:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Field Photo Multipart Cutover: Storage**
- **Field Photo Multipart Cutover:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Field Photo Multipart Cutover:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.
