import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const endpoint = process.env.R2_ENDPOINT;
const bucket = process.env.R2_BUCKET;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

const EXTENSIONS_BY_CONTENT_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

let s3Client = null;

function getClient() {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !publicBaseUrl) {
    throw new Error("Image storage is not configured.");
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  return s3Client;
}

export function isSupportedImageContentType(contentType) {
  return Object.prototype.hasOwnProperty.call(EXTENSIONS_BY_CONTENT_TYPE, contentType);
}

export async function createPresignedUpload({ userId, contentType }) {
  const extension = EXTENSIONS_BY_CONTENT_TYPE[contentType];
  const objectKey = `posts/${userId}/${randomUUID()}.${extension}`;
  const client = getClient();

  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: contentType }),
    { expiresIn: 300 },
  );

  return { objectKey, uploadUrl, publicUrl: publicUrlForObjectKey(objectKey) };
}

export function publicUrlForObjectKey(objectKey) {
  return `${publicBaseUrl}/${objectKey}`;
}
