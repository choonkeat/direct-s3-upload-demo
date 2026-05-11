import { randomBytes } from 'node:crypto';
import { config, mockEndpoint } from './config.js';
import type {
  PresignRequest,
  PresignedPutResponse,
  PresignedPostResponse,
} from './types.js';

const fakeSig = () => randomBytes(16).toString('hex');
const fakeDate = () => {
  const d = new Date();
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '').slice(0, 15) + 'Z';
};
const expiresIso = () =>
  new Date(Date.now() + config.presignExpiresIn * 1000).toISOString();

export function presignPutMock(
  req: PresignRequest,
  key: string,
): PresignedPutResponse {
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `MOCKKEYID/${fakeDate().slice(0, 8)}/${config.region}/s3/aws4_request`,
    'X-Amz-Date': fakeDate(),
    'X-Amz-Expires': String(config.presignExpiresIn),
    'X-Amz-SignedHeaders': 'host;content-type;content-length',
    'X-Amz-Signature': fakeSig(),
  });
  const uploadUrl = `${mockEndpoint()}/${key}?${params.toString()}`;
  return {
    mode: 'PUT',
    uploadUrl,
    key,
    headers: { 'Content-Type': req.contentType },
    expiresAt: expiresIso(),
  };
}

export function presignPostMock(
  req: PresignRequest,
  key: string,
): PresignedPostResponse {
  const policy = Buffer.from(
    JSON.stringify({
      expiration: expiresIso(),
      conditions: [
        { bucket: config.bucket },
        ['starts-with', '$key', config.keyPrefix],
        ['content-length-range', 1, config.maxUploadBytes],
        ...(config.allowedContentTypePrefix
          ? [['starts-with', '$Content-Type', config.allowedContentTypePrefix]]
          : []),
      ],
    }),
  ).toString('base64');

  const fields: Record<string, string> = {
    key,
    'Content-Type': req.contentType,
    'x-amz-algorithm': 'AWS4-HMAC-SHA256',
    'x-amz-credential': `MOCKKEYID/${fakeDate().slice(0, 8)}/${config.region}/s3/aws4_request`,
    'x-amz-date': fakeDate(),
    policy,
    'x-amz-signature': fakeSig(),
  };

  return {
    mode: 'POST',
    uploadUrl: mockEndpoint() + '/',
    fields,
    key,
    expiresAt: expiresIso(),
    conditions: {
      maxBytes: config.maxUploadBytes,
      contentTypePrefix: config.allowedContentTypePrefix,
      keyPrefix: config.keyPrefix,
    },
  };
}
