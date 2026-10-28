import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError, z } from "zod";
import { InfraiError } from "./infrai_storage.js";
import { FinishPhotoUpload, PhotoUploadWorkflow, StartPhotoUpload } from "./photo_upload_workflow.js";

const bucket = process.env.MEDIA_BUCKET ?? "field-service-work-order-media";
const workflow = new PhotoUploadWorkflow(bucket);
const app = express();
app.use(express.json({ limit: "64kb" }));

app.post("/work-order-photo-uploads", async (request, response, next) => {
  try {
    const input = StartPhotoUpload.parse(request.body);
    const result = await workflow.start(input);
    response.status(result.accepted ? 201 : 409).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/work-order-photo-uploads/complete", async (request, response, next) => {
  try {
    const input = FinishPhotoUpload.parse(request.body);
    const result = await workflow.finish(input);
    response.status(result.accepted ? 200 : 409).json(result);
  } catch (error) {
    next(error);
  }
});

const AbortPhotoUpload = z.object({ uploadId: z.string().trim().min(1) });
app.post("/work-order-photo-uploads/abort", async (request, response, next) => {
  try {
    const { uploadId } = AbortPhotoUpload.parse(request.body);
    await workflow.abort(uploadId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    response.status(400).json({ error: "invalid_request", issues: error.issues });
    return;
  }
  if (error instanceof InfraiError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    response.status(status).json({ error: error.code, message: error.message });
    return;
  }
  response.status(502).json({ error: "storage_request_failed" });
});

const port = Number(process.env.PORT ?? 3000);
await workflow.ensureBucket();
app.listen(port, () => {
  console.log(`Work-order media service listening on http://localhost:${port}`);
});
