import fs from "node:fs";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/core";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { downloadLineMedia } from "./download.js";
import {
  createDriveArchiveClient,
  DriveArchiveError,
  parseServiceAccountJson,
  type DriveArchiveClient,
  type ServiceAccountInfo,
} from "./drive-archive.js";
import { pushMessageLine } from "./send.js";
import type { LineDriveArchiveConfig, ResolvedLineAccount } from "./types.js";

interface ClientCacheEntry {
  client: DriveArchiveClient;
  rootFolderId: string;
  fingerprint: string;
}

const clientCache = new Map<string, ClientCacheEntry>();

export interface LineDriveArchiveTarget {
  messageType: "image" | "file";
  messageId: string;
  filename: string;
}

export interface ArchiveLineMediaParams {
  account: ResolvedLineAccount;
  runtime: RuntimeEnv;
  groupId: string;
  mediaMaxBytes: number;
  target: LineDriveArchiveTarget;
}

export async function archiveLineMediaToDrive(params: ArchiveLineMediaParams): Promise<void> {
  const { account, runtime, groupId, mediaMaxBytes, target } = params;
  const config = account.config.driveArchive;
  if (!config?.enabled) {
    return;
  }
  if (!config.rootFolderId) {
    runtime.error(danger("line: drive-archive: rootFolderId missing"));
    return;
  }

  const client = resolveDriveArchiveClient({
    accountId: account.accountId,
    config,
    runtime,
  });
  if (!client) {
    return;
  }

  let downloadedPath: string | undefined;
  try {
    const media = await downloadLineMedia(
      target.messageId,
      account.channelAccessToken,
      mediaMaxBytes,
    );
    downloadedPath = media.path;
    const folderId = await client.getOrCreateGroupFolder(groupId);
    const uploaded = await client.uploadFile({
      folderId,
      filename: target.filename,
      filePath: media.path,
      contentType: media.contentType,
    });
    await client.trySetPublicReader(uploaded.id);

    logVerbose(
      `line: drive-archive: uploaded ${target.filename} (${uploaded.id}) for group ${groupId}`,
    );

    if (config.replyOnSuccess !== false) {
      await safePushLine({
        groupId,
        accountId: account.accountId,
        text: formatSuccessReply({
          filename: target.filename,
          groupId,
          webViewLink: uploaded.webViewLink,
        }),
        runtime,
      });
    }
  } catch (err) {
    const message = err instanceof DriveArchiveError ? err.message : String(err);
    runtime.error(danger(`line: drive-archive: ${message}`));
    if (config.replyOnFailure !== false) {
      await safePushLine({
        groupId,
        accountId: account.accountId,
        text: formatFailureReply({ filename: target.filename, error: message }),
        runtime,
      });
    }
  } finally {
    if (downloadedPath) {
      fs.promises.unlink(downloadedPath).catch(() => undefined);
    }
  }
}

interface ResolveClientParams {
  accountId: string;
  config: LineDriveArchiveConfig;
  runtime: RuntimeEnv;
}

function resolveDriveArchiveClient(params: ResolveClientParams): DriveArchiveClient | undefined {
  const { accountId, config, runtime } = params;
  const rootFolderId = config.rootFolderId?.trim();
  if (!rootFolderId) {
    return undefined;
  }

  const serviceAccountInfo = loadServiceAccountInfo(config, runtime);
  if (!serviceAccountInfo) {
    return undefined;
  }

  const fingerprint = `${rootFolderId}::${serviceAccountInfo.client_email}`;
  const cached = clientCache.get(accountId);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.client;
  }

  const client = createDriveArchiveClient({
    serviceAccountInfo,
    rootFolderId,
  });
  clientCache.set(accountId, { client, rootFolderId, fingerprint });
  return client;
}

function loadServiceAccountInfo(
  config: LineDriveArchiveConfig,
  runtime: RuntimeEnv,
): ServiceAccountInfo | undefined {
  const inline = config.serviceAccountJson?.trim();
  if (inline) {
    try {
      return parseServiceAccountJson(inline);
    } catch (err) {
      runtime.error(danger(`line: drive-archive: ${String(err)}`));
      return undefined;
    }
  }

  const filePath = config.serviceAccountJsonFile?.trim();
  if (!filePath) {
    runtime.error(
      danger("line: drive-archive: serviceAccountJson or serviceAccountJsonFile required"),
    );
    return undefined;
  }

  const raw = tryReadSecretFileSync(filePath, "Drive archive service account", {
    rejectSymlink: true,
  });
  if (!raw) {
    runtime.error(danger(`line: drive-archive: failed to read ${filePath}`));
    return undefined;
  }

  try {
    return parseServiceAccountJson(raw);
  } catch (err) {
    runtime.error(danger(`line: drive-archive: ${String(err)}`));
    return undefined;
  }
}

interface SafePushParams {
  groupId: string;
  accountId: string;
  text: string;
  runtime: RuntimeEnv;
}

async function safePushLine(params: SafePushParams): Promise<void> {
  try {
    await pushMessageLine(params.groupId, params.text, {
      accountId: params.accountId,
    });
  } catch (err) {
    params.runtime.error(danger(`line: drive-archive: reply push failed: ${String(err)}`));
  }
}

export function formatSuccessReply(params: {
  filename: string;
  groupId: string;
  webViewLink?: string;
}): string {
  const link = params.webViewLink ? `\n🔗 ${params.webViewLink}` : "";
  return [
    "✅ File saved to Google Drive",
    `📄 ${params.filename}`,
    `📁 ${params.groupId}${link}`,
  ].join("\n");
}

export function formatFailureReply(params: { filename: string; error: string }): string {
  return [`❌ Failed to save file: ${params.filename}`, `Error: ${params.error}`].join("\n");
}

export function __clearDriveArchiveClientCacheForTests(): void {
  clientCache.clear();
}
