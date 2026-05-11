export interface PresignRequest {
  filename: string;
  contentType: string;
  size: number;
}

export interface PresignedPutResponse {
  mode: 'PUT';
  uploadUrl: string;
  key: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface PresignedPostResponse {
  mode: 'POST';
  uploadUrl: string;
  fields: Record<string, string>;
  key: string;
  expiresAt: string;
  conditions: {
    maxBytes: number;
    contentTypePrefix: string | null;
    keyPrefix: string;
  };
}

export type PresignResponse = PresignedPutResponse | PresignedPostResponse;

export interface UploadedFile {
  key: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  via: 'PUT' | 'POST';
}

export interface ListFilesResponse {
  mode: 'real' | 'mock';
  files: UploadedFile[];
}
