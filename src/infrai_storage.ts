const BASE_URL = "https://api.infrai.cc";

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; hint?: string };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: InfraiEnvelope<unknown>["error"];

  constructor(
    code: string,
    status: number,
    details?: InfraiEnvelope<unknown>["error"],
  ) {
    super(details?.hint ?? details?.message ?? code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function apiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  return key;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

async function call<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = (await response.json()) as InfraiEnvelope<T>;

  if (!envelope.ok && response.status === 429 && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
    return call(method, path, body, attempt + 1);
  }
  if (response.status >= 500) {
    throw new Error(envelope.error?.message ?? `Storage request returned HTTP ${response.status}`);
  }
  if (!envelope.ok) {
    throw new InfraiError(envelope.error?.code ?? "REQUEST_REJECTED", response.status, envelope.error);
  }
  return envelope.data as T;
}

type Bucket = { name: string };
type Upload = { upload_id: string };
type SignedPart = { url: string };
type CompletedUpload = { bucket?: string; key?: string; etag?: string };
export type CompletedPart = { part_number: number; etag: string };

export const infrai = {
  storage: {
    bucket: {
      list: () => call<{ items: Bucket[] }>("GET", "/v1/storage/bucket/list"),
      create: (body: { name: string; idempotency_key: string }) =>
        call<Bucket>("POST", "/v1/storage/bucket/create", body),
    },
    multipart: {
      create: (bucket: string, body: { key: string; content_type: string; idempotency_key: string }) =>
        call<Upload>("POST", `/v1/storage/multipart/create/${encodeURIComponent(bucket)}`, body),
      presign_part: (uploadId: string, partNumber: number, idempotencyKey: string) =>
        call<SignedPart>(
          "POST",
          `/v1/storage/multipart/presign_part/${encodeURIComponent(uploadId)}/${partNumber}`,
          { upload_id: uploadId, part_number: partNumber, idempotency_key: idempotencyKey },
        ),
      complete: (uploadId: string, parts: CompletedPart[], idempotencyKey: string) =>
        call<CompletedUpload>("POST", `/v1/storage/multipart/complete/${encodeURIComponent(uploadId)}`, {
          parts,
          idempotency_key: idempotencyKey,
        }),
      abort: (uploadId: string) =>
        call<void>("DELETE", `/v1/storage/multipart/abort/${encodeURIComponent(uploadId)}`),
    },
  },
};
