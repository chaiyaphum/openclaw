import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDriveArchiveClient,
  DriveArchiveError,
  parseServiceAccountJson,
} from "./drive-archive.js";

const FAKE_SERVICE_ACCOUNT = {
  client_email: "bot@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
};

interface FakeResponseInit {
  status?: number;
  body?: unknown;
}

function fakeJsonResponse({ status = 200, body = {} }: FakeResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(options: {
  fetchImpl: ReturnType<typeof vi.fn>;
  sleep?: (ms: number) => Promise<void>;
}) {
  return createDriveArchiveClient({
    serviceAccountInfo: FAKE_SERVICE_ACCOUNT,
    rootFolderId: "root-123",
    getAccessToken: async () => "fake-token",
    fetchImpl: options.fetchImpl as unknown as typeof fetch,
    sleep: options.sleep ?? (async () => undefined),
  });
}

describe("parseServiceAccountJson", () => {
  it("returns client_email and private_key on valid input", () => {
    const parsed = parseServiceAccountJson(JSON.stringify(FAKE_SERVICE_ACCOUNT));
    expect(parsed.client_email).toBe(FAKE_SERVICE_ACCOUNT.client_email);
    expect(parsed.private_key).toBe(FAKE_SERVICE_ACCOUNT.private_key);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseServiceAccountJson("not json")).toThrow(DriveArchiveError);
  });

  it("throws when required fields are missing", () => {
    expect(() => parseServiceAccountJson(JSON.stringify({ client_email: "a" }))).toThrow(
      DriveArchiveError,
    );
  });
});

describe("DriveArchiveClient.getOrCreateGroupFolder", () => {
  it("returns existing folder id from files.list", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        fakeJsonResponse({ body: { files: [{ id: "folder-1", name: "G1" }] } }),
      );
    const client = makeClient({ fetchImpl });
    await expect(client.getOrCreateGroupFolder("G1")).resolves.toBe("folder-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toContain("supportsAllDrives=true");
    expect(url).toContain("corpora=allDrives");
  });

  it("caches subsequent calls for the same group", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeJsonResponse({ body: { files: [{ id: "folder-1" }] } }));
    const client = makeClient({ fetchImpl });
    await client.getOrCreateGroupFolder("G1");
    await client.getOrCreateGroupFolder("G1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("creates folder when list returns empty", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeJsonResponse({ body: { files: [] } }))
      .mockResolvedValueOnce(fakeJsonResponse({ body: { id: "folder-new" } }));
    const client = makeClient({ fetchImpl });
    await expect(client.getOrCreateGroupFolder("G2")).resolves.toBe("folder-new");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, createInit] = fetchImpl.mock.calls[1] ?? [];
    const body = JSON.parse((createInit as RequestInit).body as string);
    expect(body).toMatchObject({
      name: "G2",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root-123"],
    });
  });

  it("escapes single quotes in folder names", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeJsonResponse({ body: { files: [{ id: "f" }] } }));
    const client = makeClient({ fetchImpl });
    await client.getOrCreateGroupFolder("G'apos");
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(url as string).toContain("G%5C%27apos");
  });
});

describe("DriveArchiveClient.uploadFile", () => {
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = path.join(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), "drive-archive-test-")),
      "hello.bin",
    );
    await fs.promises.writeFile(tmpFile, Buffer.from("hello world", "utf8"));
  });

  afterEach(async () => {
    await fs.promises.rm(path.dirname(tmpFile), { recursive: true, force: true });
  });

  it("uploads multipart body and returns id + link", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      fakeJsonResponse({
        body: { id: "file-1", webViewLink: "https://drive.example/file-1" },
      }),
    );
    const client = makeClient({ fetchImpl });
    const result = await client.uploadFile({
      folderId: "folder-1",
      filename: "hello.bin",
      filePath: tmpFile,
      contentType: "application/octet-stream",
    });
    expect(result).toEqual({
      id: "file-1",
      webViewLink: "https://drive.example/file-1",
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toContain("uploadType=multipart");
    expect(url).toContain("supportsAllDrives=true");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["content-type"]).toContain("multipart/related");
    const rawBody = (init as RequestInit).body as Uint8Array;
    expect(rawBody).toBeInstanceOf(Uint8Array);
    const bodyStr = Buffer.from(rawBody).toString("utf8");
    expect(bodyStr).toContain("hello world");
    expect(bodyStr).toContain('"name":"hello.bin"');
    expect(bodyStr).toContain('"parents":["folder-1"]');
    expect(bodyStr).toContain("application/octet-stream");
  });

  it("throws when upload response has no id", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(fakeJsonResponse({ body: {} }));
    const client = makeClient({ fetchImpl });
    await expect(
      client.uploadFile({
        folderId: "folder-1",
        filename: "x.bin",
        filePath: tmpFile,
      }),
    ).rejects.toBeInstanceOf(DriveArchiveError);
  });
});

describe("retry behavior", () => {
  it("retries on 503 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(fakeJsonResponse({ body: { files: [{ id: "f" }] } }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ fetchImpl, sleep });
    await expect(client.getOrCreateGroupFolder("G")).resolves.toBe("f");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("fails fast on non-retry status", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const client = makeClient({ fetchImpl });
    await expect(client.getOrCreateGroupFolder("G")).rejects.toBeInstanceOf(DriveArchiveError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces DriveArchiveError after exhausting retries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ fetchImpl, sleep });
    await expect(client.getOrCreateGroupFolder("G")).rejects.toBeInstanceOf(DriveArchiveError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
