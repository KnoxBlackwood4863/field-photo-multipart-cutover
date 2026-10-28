import { z } from "zod";
import { infrai, type CompletedPart } from "./infrai_storage.js";

export const DispatchStatus = z.enum(["scheduled", "dispatched", "on_site", "completed"]);

export const StartPhotoUpload = z.object({
  requestId: z.string().uuid(),
  workOrderId: z.string().trim().min(1).max(80),
  technicianId: z.string().trim().min(1).max(80),
  dispatchStatus: DispatchStatus,
  fileName: z.string().trim().min(1).max(180),
  contentType: z.string().regex(/^image\/[a-z0-9.+-]+$/i),
  sizeBytes: z.number().int().positive().max(5_000_000_000),
});

export const FinishPhotoUpload = z.object({
  requestId: z.string().uuid(),
  workOrderId: z.string().trim().min(1).max(80),
  technicianId: z.string().trim().min(1).max(80),
  dispatchStatus: DispatchStatus,
  uploadId: z.string().trim().min(1),
  parts: z.array(z.object({ part_number: z.number().int().positive(), etag: z.string().trim().min(1) })).min(1),
});

export type DispatchStatus = z.infer<typeof DispatchStatus>;

export function uploadDecision(status: DispatchStatus):
  | { accepted: true; followUp: "technician-review" }
  | { accepted: false; reason: string } {
  if (status === "dispatched" || status === "on_site") {
    return { accepted: true, followUp: "technician-review" };
  }
  return { accepted: false, reason: "Photos are accepted after dispatch and before completion" };
}

function objectKey(workOrderId: string, technicianId: string, requestId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `work-orders/${workOrderId}/technicians/${technicianId}/${requestId}-${safeName}`;
}

export class PhotoUploadWorkflow {
  readonly bucket: string;

  constructor(bucket: string) {
    this.bucket = bucket;
  }

  async ensureBucket(): Promise<void> {
    const { items } = await infrai.storage.bucket.list();
    if (!items.some((item) => item.name === this.bucket)) {
      await infrai.storage.bucket.create({
        name: this.bucket,
        idempotency_key: `bucket-${this.bucket}`,
      });
    }
  }

  async start(input: z.infer<typeof StartPhotoUpload>) {
    const decision = uploadDecision(input.dispatchStatus);
    if (!decision.accepted) return decision;

    const key = objectKey(input.workOrderId, input.technicianId, input.requestId, input.fileName);
    const upload = await infrai.storage.multipart.create(this.bucket, {
      key,
      content_type: input.contentType,
      idempotency_key: `${input.requestId}-create`,
    });
    const partSizeBytes = 8 * 1024 * 1024;
    const partCount = Math.ceil(input.sizeBytes / partSizeBytes);
    const parts = await Promise.all(
      Array.from({ length: partCount }, async (_, index) => {
        const partNumber = index + 1;
        const signed = await infrai.storage.multipart.presign_part(
          upload.upload_id,
          partNumber,
          `${input.requestId}-part-${partNumber}`,
        );
        return { partNumber, method: "PUT" as const, uploadUrl: signed.url };
      }),
    );
    return {
      accepted: true as const,
      workOrderId: input.workOrderId,
      uploadId: upload.upload_id,
      key,
      partSizeBytes,
      parts,
      followUp: decision.followUp,
    };
  }

  async finish(input: z.infer<typeof FinishPhotoUpload>) {
    const decision = uploadDecision(input.dispatchStatus);
    if (!decision.accepted) return decision;

    await infrai.storage.multipart.complete(
      input.uploadId,
      input.parts as CompletedPart[],
      `${input.requestId}-complete`,
    );
    return {
      accepted: true as const,
      workOrderId: input.workOrderId,
      mediaStatus: "uploaded" as const,
      followUp: decision.followUp,
    };
  }

  async abort(uploadId: string): Promise<void> {
    await infrai.storage.multipart.abort(uploadId);
  }
}
