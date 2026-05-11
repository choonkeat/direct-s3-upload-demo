import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { config } from './config.js';
import type {
  PresignRequest,
  PresignedPutResponse,
  PresignedPostResponse,
} from './types.js';

let _client: S3Client | null = null;
const client = () => {
  if (!_client) _client = new S3Client({ region: config.region });
  return _client;
};

export async function presignPut(
  req: PresignRequest,
  key: string,
): Promise<PresignedPutResponse> {
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: req.contentType,
    ContentLength: req.size,
  });
  const uploadUrl = await getSignedUrl(client(), command, {
    expiresIn: config.presignExpiresIn,
    signableHeaders: new Set(['content-type', 'content-length']),
  });
  return {
    mode: 'PUT',
    uploadUrl,
    key,
    headers: { 'Content-Type': req.contentType },
    expiresAt: new Date(Date.now() + config.presignExpiresIn * 1000).toISOString(),
  };
}

export async function presignPost(
  req: PresignRequest,
  key: string,
): Promise<PresignedPostResponse> {
  const conditions: Array<Record<string, string> | (string | number)[]> = [
    ['content-length-range', 1, config.maxUploadBytes],
    ['starts-with', '$key', config.keyPrefix],
  ];
  if (config.allowedContentTypePrefix) {
    conditions.push(['starts-with', '$Content-Type', config.allowedContentTypePrefix]);
  }
  const { url, fields } = await createPresignedPost(client(), {
    Bucket: config.bucket,
    Key: key,
    Conditions: conditions as never,
    Fields: { 'Content-Type': req.contentType },
    Expires: config.presignExpiresIn,
  });
  return {
    mode: 'POST',
    uploadUrl: url,
    fields,
    key,
    expiresAt: new Date(Date.now() + config.presignExpiresIn * 1000).toISOString(),
    conditions: {
      maxBytes: config.maxUploadBytes,
      contentTypePrefix: config.allowedContentTypePrefix,
      keyPrefix: config.keyPrefix,
    },
  };
}
