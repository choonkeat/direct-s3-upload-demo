import 'dotenv/config';

const bucket = process.env.AWS_S3_BUCKET?.trim();
const region = process.env.AWS_REGION?.trim() ?? 'us-east-1';

export const mode: 'real' | 'mock' = bucket ? 'real' : 'mock';

export const config = {
  mode,
  port: Number(process.env.PORT ?? 8787),
  bucket: bucket ?? 'mock-bucket',
  region,
  // POST policy constraints (PUT does not enforce these).
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 1 * 1024 * 1024),
  allowedContentTypePrefix:
    process.env.ALLOWED_CONTENT_TYPE_PREFIX?.trim() || 'image/png',
  keyPrefix: process.env.KEY_PREFIX?.trim() || 'uploads/',
  presignExpiresIn: Number(process.env.PRESIGN_EXPIRES_IN ?? 300),
};

// Relative path so the browser resolves it against whatever origin
// is currently in the address bar (works through proxies / port-forwards
// / Preview tabs without needing to know the public hostname).
export const mockEndpoint = () => `/__mock_s3__/${config.bucket}`;
