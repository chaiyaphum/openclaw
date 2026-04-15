import fs from "node:fs";
import { JWT } from "google-auth-library";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 503]);
const RETRY_WAIT_MS = 2000;
const MULTIPART_BOUNDARY = "openclaw-line-drive-archive";

export interface DriveArchiveClientOptions {
  serviceAccountInfo: ServiceAccountInfo;
  rootFolderId: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
}

export interface ServiceAccountInfo {
  client_email: string;
  private_key: string;
}

export interface UploadFileOptions {
  folderId: string;
  filename: string;
  filePath: string;
  contentType?: string;
}

export interface UploadFileResult {
  id: string;
  webViewLink?: string;
}

export class DriveArchiveError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DriveArchiveError";
  }
}

export interface DriveArchiveClient {
  getOrCreateGroupFolder(groupId: string): Promise<string>;
  uploadFile(opts: UploadFileOptions): Promise<UploadFileResult>;
  trySetPublicReader(fileId: string): Promise<void>;
}

export function createDriveArchiveClient(opts: DriveArchiveClientOptions): DriveArchiveClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const folderCache = new Map<string, string>();

  let lazyJwt: JWT | undefined;
  const getAccessToken =
    opts.getAccessToken ??
    (async () => {
      if (!lazyJwt) {
        lazyJwt = new JWT({
          email: opts.serviceAccountInfo.client_email,
          key: opts.serviceAccountInfo.private_key,
          scopes: DRIVE_SCOPES,
        });
      }
      const { token } = await lazyJwt.getAccessToken();
      if (!token) {
        throw new DriveArchiveError("Failed to acquire Google access token");
      }
      return token;
    });

  async function sendWithRetry(
    label: string,
    build: () => Promise<{ url: string; init: RequestInit }>,
  ): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let res: Response | undefined;
      try {
        const { url, init } = await build();
        res = await fetchImpl(url, init);
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS) {
          throw new DriveArchiveError(`Drive ${label} failed: ${String(err)}`, err);
        }
        await sleep(RETRY_WAIT_MS * attempt);
        continue;
      }

      if (res.ok) {
        return res;
      }
      if (!RETRY_STATUSES.has(res.status)) {
        const body = await safeReadBody(res);
        throw new DriveArchiveError(
          `Drive ${label} failed: ${res.status} ${res.statusText} ${body}`.trim(),
        );
      }

      lastErr = new DriveArchiveError(`Drive ${label} retryable: ${res.status}`);
      if (attempt === MAX_ATTEMPTS) {
        throw lastErr;
      }
      await sleep(RETRY_WAIT_MS * attempt);
    }
    throw new DriveArchiveError(`Drive ${label} exhausted retries: ${String(lastErr)}`, lastErr);
  }

  async function getOrCreateGroupFolder(groupId: string): Promise<string> {
    const cached = folderCache.get(groupId);
    if (cached) {
      return cached;
    }

    const token = await getAccessToken();
    const query = `name='${escapeQuery(groupId)}' and '${opts.rootFolderId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
    const listUrl =
      `${DRIVE_API_BASE}/files?` +
      new URLSearchParams({
        q: query,
        spaces: "drive",
        fields: "files(id, name)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: "allDrives",
      }).toString();

    const listRes = await sendWithRetry("files.list", async () => ({
      url: listUrl,
      init: {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    }));
    const listBody = (await listRes.json()) as { files?: Array<{ id: string }> };
    const existingId = listBody.files?.[0]?.id;
    if (existingId) {
      folderCache.set(groupId, existingId);
      return existingId;
    }

    const createRes = await sendWithRetry("files.create(folder)", async () => ({
      url: `${DRIVE_API_BASE}/files?supportsAllDrives=true`,
      init: {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: groupId,
          mimeType: FOLDER_MIME,
          parents: [opts.rootFolderId],
        }),
      },
    }));
    const createBody = (await createRes.json()) as { id?: string };
    if (!createBody.id) {
      throw new DriveArchiveError("Drive folder create returned no id");
    }
    folderCache.set(groupId, createBody.id);
    return createBody.id;
  }

  async function uploadFile(upload: UploadFileOptions): Promise<UploadFileResult> {
    const token = await getAccessToken();
    const fileBuffer = await fs.promises.readFile(upload.filePath);
    const metadata = {
      name: upload.filename,
      parents: [upload.folderId],
    };
    const contentType = upload.contentType ?? "application/octet-stream";
    const body = buildMultipartBody(metadata, fileBuffer, contentType);

    const res = await sendWithRetry("files.create(upload)", async () => ({
      url: `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`,
      init: {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/related; boundary=${MULTIPART_BOUNDARY}`,
        },
        body: new Uint8Array(body),
      },
    }));
    const responseBody = (await res.json()) as { id?: string; webViewLink?: string };
    if (!responseBody.id) {
      throw new DriveArchiveError("Drive upload returned no file id");
    }
    return { id: responseBody.id, webViewLink: responseBody.webViewLink };
  }

  async function trySetPublicReader(fileId: string): Promise<void> {
    try {
      const token = await getAccessToken();
      await fetchImpl(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}/permissions?supportsAllDrives=true`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ role: "reader", type: "anyone" }),
        },
      );
    } catch {
      // Shared Drives may forbid external sharing; degrade silently.
    }
  }

  return { getOrCreateGroupFolder, uploadFile, trySetPublicReader };
}

export function parseServiceAccountJson(raw: string): ServiceAccountInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DriveArchiveError(`Service account JSON is not valid JSON: ${String(err)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new DriveArchiveError("Service account JSON must be an object");
  }
  const candidate = parsed as { client_email?: unknown; private_key?: unknown };
  if (typeof candidate.client_email !== "string" || typeof candidate.private_key !== "string") {
    throw new DriveArchiveError("Service account JSON missing client_email or private_key");
  }
  return {
    client_email: candidate.client_email,
    private_key: candidate.private_key,
  };
}

function buildMultipartBody(
  metadata: Record<string, unknown>,
  fileBuffer: Buffer,
  contentType: string,
): Buffer {
  const boundary = MULTIPART_BOUNDARY;
  const header =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;
  return Buffer.concat([Buffer.from(header, "utf8"), fileBuffer, Buffer.from(footer, "utf8")]);
}

function escapeQuery(value: string): string {
  return value.replace(/'/g, "\\'");
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
