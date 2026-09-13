import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, open, readFile, readdir, rename, stat, statfs, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import {
  climbingCommandSchema,
  climbingStateSchema,
  emptyClimbing,
  goalReferenceSchema,
  type ClimbingChange,
  type ClimbingCommand,
  type ClimbingState,
  type GoalReference,
} from "../lib/climbing.ts";
import { StoreBusyError, withPrivateLock, writePrivateJson } from "./private-store.ts";

class ClimbingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "invalid_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_JSON_BYTES = 3_000_000;
const MAX_MEDIA_BYTES = 200_000_000;
const MAX_REFERENCES_PER_GOAL = 12;
const MAX_GOAL_MEDIA_BYTES = 1_000_000_000;
const MAX_TOTAL_MEDIA_BYTES = 5_000_000_000;
const MIN_FREE_SPACE_BYTES = 250_000_000;
const MAX_MEDIA_PROBE_BYTES = 25_000_000;
const MAX_CONCURRENT_UPLOADS = 1;
const execFileAsync = promisify(execFile);
const identifierSchema = z.string().uuid();
const storedIdentifierPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const fileNameSchema = z.string().trim().min(1).max(240)
  .refine(value => !/[\\/\0-\x1f\x7f]/.test(value), "Choose a file name without path separators or control characters.");
const linkInputSchema = z.object({ requestId: identifierSchema, reference: goalReferenceSchema }).strict();
const deleteInputSchema = z.object({ requestId: identifierSchema, goalId: identifierSchema, referenceId: identifierSchema }).strict();
const additiveGoalKeys = ["environment", "discipline", "ropeStyle", "attempts"] as const;
const allowedUploadTypes = new Set([
  "application/octet-stream",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
]);

function jsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preserveOmittedGoalFields(value: unknown, current: ClimbingState["goals"][number] | undefined) {
  if (!current || !jsonRecord(value)) return value;
  const next = { ...value };
  for (const key of additiveGoalKeys) if (!Object.hasOwn(value, key)) next[key] = current[key];
  return next;
}

function preserveCommandGoalFields(value: unknown, current: ClimbingState) {
  if (!jsonRecord(value) || !Array.isArray(value.changes)) return value;
  return {
    ...value,
    changes: value.changes.map(change => {
      if (!jsonRecord(change) || change.kind !== "goal" || !jsonRecord(change.value) || typeof change.value.id !== "string") return change;
      const goalId = change.value.id;
      const existing = current.goals.find(goal => goal.id === goalId);
      return { ...change, value: preserveOmittedGoalFields(change.value, existing) };
    }),
  };
}

function preserveStateGoalFields(value: unknown, current: ClimbingState) {
  if (!jsonRecord(value) || !Array.isArray(value.goals)) return value;
  return {
    ...value,
    goals: value.goals.map(goal => {
      if (!jsonRecord(goal) || typeof goal.id !== "string") return goal;
      const existing = current.goals.find(item => item.id === goal.id);
      return preserveOmittedGoalFields(goal, existing);
    }),
  };
}

function requestPath(req: IncomingMessage) {
  const pathname = new URL(req.url || "/", "http://workspace.local").pathname;
  return pathname.replace(/^\/api\/climbing(?=\/|$)/, "") || "/";
}

function header(req: IncomingMessage, name: string) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function decodedHeader(req: IncomingMessage, name: string) {
  try {
    return decodeURIComponent(header(req, name));
  } catch {
    throw new ClimbingError("The media details could not be read.");
  }
}

function mediaType(prefix: Buffer, byteSize: number): { kind: "image" | "video"; mimeType: NonNullable<GoalReference["mimeType"]> } | null {
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return { kind: "image", mimeType: "image/jpeg" };
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mimeType: "image/png" };
  if (prefix.length >= 12 && prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP") return { kind: "image", mimeType: "image/webp" };
  if (prefix.length >= 16 && prefix.subarray(4, 8).toString("ascii") === "ftyp") {
    const boxSize = prefix.readUInt32BE(0);
    if (boxSize < 16 || boxSize > byteSize) return null;
    const major = prefix.subarray(8, 12).toString("ascii");
    const compatible: string[] = [];
    for (let offset = 16; offset + 4 <= Math.min(prefix.length, boxSize); offset += 4) compatible.push(prefix.subarray(offset, offset + 4).toString("ascii"));
    const brands = [major, ...compatible];
    if (/^3g/.test(major) || brands.some(brand => ["M4A ", "M4B ", "M4P ", "F4A ", "F4B ", "avif", "avis"].includes(brand))) return null;
    if (brands.some(brand => ["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand))) return { kind: "image", mimeType: "image/heic" };
    if (brands.some(brand => brand === "mif1" || brand === "msf1")) return { kind: "image", mimeType: "image/heif" };
    if (major === "qt  ") return { kind: "video", mimeType: "video/quicktime" };
    if (brands.some(brand => ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "MSNV", "dash"].includes(brand))) return { kind: "video", mimeType: "video/mp4" };
  }
  return null;
}

function parseRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new ClimbingError("Choose one valid byte range.", 416, "invalid_range");
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ClimbingError("Choose one valid byte range.", 416, "invalid_range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new ClimbingError("Choose one valid byte range.", 416, "invalid_range");
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function dispositionFileName(value: string) {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename*=UTF-8''${encoded}`;
}

async function readPrefix(path: string, length = 64) {
  const handle = await open(path, "r");
  try {
    const prefix = Buffer.alloc(length);
    const { bytesRead } = await handle.read(prefix, 0, length, 0);
    return prefix.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function positiveProperty(output: string, property: string) {
  const match = new RegExp(`${property}:\\s*(\\d+)`).exec(output);
  return match ? Number(match[1]) : 0;
}

async function probeImage(path: string, mimeType: NonNullable<GoalReference["mimeType"]>) {
  const outputPath = `${path}.${randomUUID()}.probe.png`;
  try {
    const inspected = await execFileAsync(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", path],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 64_000 },
    );
    const width = positiveProperty(inspected.stdout, "pixelWidth");
    const height = positiveProperty(inspected.stdout, "pixelHeight");
    const format = /format:\s*([^\s]+)/.exec(inspected.stdout)?.[1]?.toLowerCase() ?? "";
    const expectedFormats: Record<string, string[]> = {
      "image/jpeg": ["jpeg", "jpg"],
      "image/png": ["png"],
      "image/webp": ["webp"],
      "image/heic": ["heic", "heif"],
      "image/heif": ["heic", "heif"],
    };
    if (!width || !height || width * height > 150_000_000 || !expectedFormats[mimeType]?.includes(format)) return false;
    await execFileAsync(
      "/usr/bin/sips",
      ["--resampleHeightWidthMax", "8", "--setProperty", "format", "png", path, "--out", outputPath],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 128_000 },
    );
    const output = await stat(outputPath);
    return output.isFile() && output.size > 0 && output.size <= MAX_MEDIA_PROBE_BYTES;
  } catch {
    return false;
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

type IsoBox = { type: string; payloadStart: number; end: number };

function isoBoxes(value: Buffer, start: number, end: number): IsoBox[] | null {
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8 || boxes.length >= 10_000) return null;
    const size32 = value.readUInt32BE(offset);
    const type = value.subarray(offset + 4, offset + 8).toString("ascii");
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (end - offset < 16) return null;
      const size64 = value.readBigUInt64BE(offset + 8);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(size64);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return null;
    boxes.push({ type, payloadStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return offset === end ? boxes : null;
}

function hasVideoTrack(value: Buffer) {
  const top = isoBoxes(value, 0, value.length);
  if (!top?.some(box => box.type === "mdat" && box.end > box.payloadStart)) return false;
  for (const movie of top.filter(box => box.type === "moov")) {
    const movieChildren = isoBoxes(value, movie.payloadStart, movie.end);
    if (!movieChildren) continue;
    for (const track of movieChildren.filter(box => box.type === "trak")) {
      const trackChildren = isoBoxes(value, track.payloadStart, track.end);
      if (!trackChildren) continue;
      const header = trackChildren.find(box => box.type === "tkhd");
      const media = trackChildren.find(box => box.type === "mdia");
      if (!header || header.end - header.payloadStart < 8 || !media) continue;
      const width = value.readUInt32BE(header.end - 8);
      const height = value.readUInt32BE(header.end - 4);
      const mediaChildren = isoBoxes(value, media.payloadStart, media.end);
      const handler = mediaChildren?.find(box => box.type === "hdlr" && box.end - box.payloadStart >= 12);
      if (width > 0 && height > 0 && handler && value.subarray(handler.payloadStart + 8, handler.payloadStart + 12).toString("ascii") === "vide") return true;
    }
  }
  return false;
}

async function probeVideo(path: string, mimeType: NonNullable<GoalReference["mimeType"]>) {
  const inputPath = `${path}.${randomUUID()}.probe.${mimeType === "video/quicktime" ? "mov" : "mp4"}`;
  const outputPath = `${path}.${randomUUID()}.probe.mov`;
  try {
    await link(path, inputPath);
    await execFileAsync(
      "/usr/bin/avconvert",
      ["--source", inputPath, "--output", outputPath, "--preset", "PresetLowQuality", "--duration", "0.1", "--disableFastStart"],
      { encoding: "utf8", timeout: 45_000, maxBuffer: 256_000 },
    );
    await chmod(outputPath, 0o600);
    const output = await stat(outputPath);
    if (!output.isFile() || output.size < 1 || output.size > MAX_MEDIA_PROBE_BYTES) return false;
    return hasVideoTrack(await readFile(outputPath));
  } catch {
    return false;
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

async function probeMedia(path: string, detected: { kind: "image" | "video"; mimeType: NonNullable<GoalReference["mimeType"]> }) {
  return detected.kind === "image" ? probeImage(path, detected.mimeType) : probeVideo(path, detected.mimeType);
}

export function createClimbingService(directory: string) {
  const file = join(directory, "climbing.private.json");
  const mediaDirectory = join(directory, "climbing-media");
  const uploadGate = join(directory, "climbing-media-upload");
  let queue: Promise<unknown> = Promise.resolve();
  let activeUploads = 0;
  let mediaReady: Promise<void> | undefined;
  const exclusive = <T>(operation: () => Promise<T>) => {
    const next = queue.catch(() => {}).then(() => withPrivateLock(file, operation));
    queue = next;
    return next;
  };

  async function read(): Promise<ClimbingState> {
    try {
      return climbingStateSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(emptyClimbing);
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new ClimbingError("Your climbing log could not be read. The saved file has been left untouched.", 500);
      throw error;
    }
  }

  async function fileExists(path: string) {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async function reconcileMediaFiles() {
    const state = await read();
    await mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
    await chmod(mediaDirectory, 0o700);
    const assetIds = new Set(state.goalReferences.filter(reference => reference.kind !== "link").map(reference => reference.id));
    const finalPattern = new RegExp(`^(${storedIdentifierPattern})$`, "i");
    const deletedPattern = new RegExp(`^(${storedIdentifierPattern})\.(${storedIdentifierPattern})\.deleted$`, "i");
    for (const entry of await readdir(mediaDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const finalMatch = finalPattern.exec(entry.name);
      if (finalMatch) {
        if (!assetIds.has(finalMatch[1])) await unlink(join(mediaDirectory, entry.name));
        continue;
      }
      const deletedMatch = deletedPattern.exec(entry.name);
      if (deletedMatch) {
        const deletedPath = join(mediaDirectory, entry.name);
        const finalPath = join(mediaDirectory, deletedMatch[1]);
        if (assetIds.has(deletedMatch[1]) && !(await fileExists(finalPath))) await rename(deletedPath, finalPath);
        else await unlink(deletedPath);
        continue;
      }
      if (entry.name.endsWith(".tmp") || entry.name.includes(".probe.")) await unlink(join(mediaDirectory, entry.name));
    }
  }

  async function ensureMediaReady() {
    // The upload gate prevents another Workspace process from creating a temp
    // or probe file while startup recovery is deciding which files are stale.
    mediaReady ??= withPrivateLock(uploadGate, () => exclusive(reconcileMediaFiles)).catch(error => {
      mediaReady = undefined;
      throw error;
    });
    await mediaReady;
  }

  const send = (res: ServerResponse, code: number, value?: unknown, headers: Record<string, string> = {}) => {
    res.statusCode = code;
    res.setHeader("Cache-Control", "no-store");
    for (const [key, responseHeader] of Object.entries(headers)) res.setHeader(key, responseHeader);
    if (code === 304) return res.end();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  };

  async function jsonBody(req: IncomingMessage, max = MAX_JSON_BYTES) {
    if (!req.headers["content-type"]?.startsWith("application/json")) throw new ClimbingError("JSON is required.", 415);
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const part of req) {
      const value = Buffer.from(part);
      size += value.length;
      if (size > max) throw new ClimbingError("Your climbing update is too large.", 413);
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  const recordFor = (state: ClimbingState, change: ClimbingChange) => change.kind === "session"
    ? state.sessions.find(item => item.id === change.value.id)
    : change.kind === "goal"
      ? state.goals.find(item => item.id === change.value.id)
      : change.kind === "routine"
        ? state.routines.find(item => item.id === change.value.id)
        : state.plans.find(item => item.id === change.value.id);

  function applyCommand(current: ClimbingState, command: ClimbingCommand) {
    let next: ClimbingState = structuredClone(current);
    let changed = false;
    for (const change of command.changes) {
      const existing = recordFor(next, change);
      const same = existing && JSON.stringify(existing) === JSON.stringify(change.value);
      if (same) continue;
      if ((change.expectedUpdatedAt === null && existing) || (change.expectedUpdatedAt !== null && (!existing || existing.updatedAt !== change.expectedUpdatedAt))) {
        throw new ClimbingError("This climbing record changed on another device. The latest saved records are loaded; review them before trying again.", 409, "entity_revision_conflict");
      }
      changed = true;
      if (change.kind === "session") next = { ...next, sessions: existing ? next.sessions.map(item => item.id === change.value.id ? change.value : item) : [...next.sessions, change.value] };
      else if (change.kind === "goal") next = { ...next, goals: existing ? next.goals.map(item => item.id === change.value.id ? change.value : item) : [...next.goals, change.value] };
      else if (change.kind === "routine") next = { ...next, routines: existing ? next.routines.map(item => item.id === change.value.id ? change.value : item) : [...next.routines, change.value] };
      else next = { ...next, plans: existing ? next.plans.map(item => item.id === change.value.id ? change.value : item) : [...next.plans, change.value] };
    }
    return { state: changed ? climbingStateSchema.parse({ ...next, revision: current.revision + 1 }) : current, replayed: !changed };
  }

  function requireGoalCapacity(state: ClimbingState, goalId: string, incomingBytes = 0) {
    if (!state.goals.some(goal => goal.id === goalId)) throw new ClimbingError("Save this goal before adding media to it.", 404, "goal_not_found");
    const goalReferences = state.goalReferences.filter(reference => reference.goalId === goalId);
    if (goalReferences.length >= MAX_REFERENCES_PER_GOAL) throw new ClimbingError("This goal already has 12 media references. Remove one before adding another.", 409, "reference_limit");
    const goalBytes = goalReferences.reduce((total, reference) => total + (reference.byteSize ?? 0), 0);
    if (goalBytes + incomingBytes > MAX_GOAL_MEDIA_BYTES) throw new ClimbingError("This goal has reached its 1 GB media limit. Remove a file before adding another.", 409, "goal_media_limit");
    const totalBytes = state.goalReferences.reduce((total, reference) => total + (reference.byteSize ?? 0), 0);
    if (totalBytes + incomingBytes > MAX_TOTAL_MEDIA_BYTES) throw new ClimbingError("Climbing media has reached its 5 GB Workspace limit. Remove an older file before adding another.", 409, "media_limit");
  }

  async function ensureUploadSpace(expectedBytes: number) {
    const available = await statfs(mediaDirectory, { bigint: true });
    const freeBytes = available.bavail * available.bsize;
    if (freeBytes < BigInt(expectedBytes + MIN_FREE_SPACE_BYTES)) throw new ClimbingError("This Mac needs more free space before Workspace can add that file.", 507, "insufficient_storage");
  }

  async function addLink(req: IncomingMessage) {
    const input = linkInputSchema.parse(await jsonBody(req, 40_000));
    if (input.reference.kind !== "link") throw new ClimbingError("Choose an HTTPS media link.");
    return exclusive(async () => {
      const current = await read();
      const existing = current.goalReferences.find(reference => reference.id === input.reference.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(input.reference)) throw new ClimbingError("This media reference ID is already in use.", 409, "reference_conflict");
        return { state: current, replayed: true };
      }
      requireGoalCapacity(current, input.reference.goalId);
      const next = climbingStateSchema.parse({ ...current, revision: current.revision + 1, goalReferences: [...current.goalReferences, input.reference] });
      await writePrivateJson(file, next);
      return { state: next, replayed: false };
    });
  }

  async function receiveUpload(req: IncomingMessage, temporaryPath: string) {
    const declared = header(req, "content-length");
    if (declared) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 1) throw new ClimbingError("Choose a non-empty photo or video.");
      if (length > MAX_MEDIA_BYTES) throw new ClimbingError("Choose a photo or video smaller than 200 MB.", 413);
    }
    const contentType = header(req, "content-type").split(";", 1)[0].trim().toLowerCase();
    if (contentType && !allowedUploadTypes.has(contentType)) throw new ClimbingError("Choose a JPEG, PNG, WebP, HEIC, HEIF, MP4, or QuickTime file.", 415);
    await mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
    const temporary = await open(temporaryPath, "wx", 0o600);
    let size = 0;
    let prefix = Buffer.alloc(0);
    let complete = false;
    try {
      for await (const part of req) {
        const value = Buffer.from(part);
        size += value.length;
        if (size > MAX_MEDIA_BYTES) throw new ClimbingError("Choose a photo or video smaller than 200 MB.", 413);
        if (prefix.length < 64) prefix = Buffer.concat([prefix, value.subarray(0, 64 - prefix.length)]);
        if (size === value.length || size % 8_000_000 < value.length) await ensureUploadSpace(value.length);
        await temporary.write(value);
      }
      if (!size) throw new ClimbingError("Choose a non-empty photo or video.");
      await temporary.sync();
      await ensureUploadSpace(0);
      complete = true;
      return { size, prefix };
    } finally {
      await temporary.close().catch(() => {});
      if (!complete) await unlink(temporaryPath).catch(() => {});
    }
  }

  async function addUpload(req: IncomingMessage) {
    const requestId = identifierSchema.parse(header(req, "x-workspace-request-id"));
    const referenceId = identifierSchema.parse(header(req, "x-workspace-reference-id"));
    const goalId = identifierSchema.parse(header(req, "x-workspace-goal-id"));
    const fileName = fileNameSchema.parse(decodedHeader(req, "x-workspace-file-name"));
    const label = z.string().trim().max(160).parse(decodedHeader(req, "x-workspace-label"));
    const temporaryPath = join(mediaDirectory, `${referenceId}.${requestId}.${randomUUID()}.tmp`);
    const finalPath = join(mediaDirectory, referenceId);
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) throw new ClimbingError("A media upload is already running. Try this file again when it finishes.", 429, "upload_busy");
    activeUploads += 1;
    try {
      return await withPrivateLock(uploadGate, async () => {
        const declaredValue = header(req, "content-length");
        const declaredBytes = declaredValue ? Number(declaredValue) : undefined;
        if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1 || declaredBytes > MAX_MEDIA_BYTES)) {
          throw new ClimbingError(declaredBytes > MAX_MEDIA_BYTES ? "Choose a photo or video smaller than 200 MB." : "Choose a non-empty photo or video.", declaredBytes > MAX_MEDIA_BYTES ? 413 : 400);
        }
        const provisional = await read();
        const provisionalExisting = provisional.goalReferences.find(reference => reference.id === referenceId);
        if (provisionalExisting) {
          if (provisionalExisting.goalId !== goalId || provisionalExisting.label !== label || provisionalExisting.fileName !== fileName || provisionalExisting.url !== null) throw new ClimbingError("This media reference ID is already in use.", 409, "reference_conflict");
        } else {
          requireGoalCapacity(provisional, goalId, declaredBytes ?? 0);
        }
        await mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
        await ensureUploadSpace(declaredBytes ?? MAX_MEDIA_BYTES);
        const uploaded = await receiveUpload(req, temporaryPath);
        const detected = mediaType(uploaded.prefix, uploaded.size);
        if (!detected) throw new ClimbingError("Workspace could not verify this photo or video format.", 415, "unsupported_media");
        await ensureUploadSpace(MAX_MEDIA_PROBE_BYTES);
        if (!await probeMedia(temporaryPath, detected)) throw new ClimbingError("Workspace could not open this as a complete photo or video.", 415, "unsupported_media");
        await ensureUploadSpace(0);
        return exclusive(async () => {
          const current = await read();
          const existing = current.goalReferences.find(reference => reference.id === referenceId);
          if (existing) {
            const matchesUpload = existing.goalId === goalId && existing.kind === detected.kind && existing.label === label && existing.fileName === fileName && existing.mimeType === detected.mimeType && existing.byteSize === uploaded.size && existing.url === null;
            if (!matchesUpload) throw new ClimbingError("This media reference ID is already in use.", 409, "reference_conflict");
            try {
              const info = await stat(finalPath);
              if (!info.isFile() || info.size !== uploaded.size) throw new ClimbingError("This saved media file is inconsistent. Remove the reference and add it again.", 500, "media_inconsistent");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              await link(temporaryPath, finalPath);
            }
            return { state: current, replayed: true };
          }
          requireGoalCapacity(current, goalId, uploaded.size);
          const reference = goalReferenceSchema.parse({
            id: referenceId,
            goalId,
            kind: detected.kind,
            label,
            url: null,
            fileName,
            mimeType: detected.mimeType,
            byteSize: uploaded.size,
            createdAt: new Date().toISOString(),
          });
          const next = climbingStateSchema.parse({ ...current, revision: current.revision + 1, goalReferences: [...current.goalReferences, reference] });
          try {
            await link(temporaryPath, finalPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ClimbingError("This media reference ID is already in use.", 409, "reference_conflict");
            throw error;
          }
          try {
            await writePrivateJson(file, next);
          } catch (error) {
            await unlink(finalPath).catch(() => {});
            throw error;
          }
          return { state: next, replayed: false };
        });
      });
    } finally {
      activeUploads -= 1;
      await unlink(temporaryPath).catch(() => {});
    }
  }

  async function deleteReference(req: IncomingMessage) {
    const input = deleteInputSchema.parse(await jsonBody(req, 20_000));
    return exclusive(async () => {
      const current = await read();
      const existing = current.goalReferences.find(reference => reference.id === input.referenceId);
      if (!existing) {
        const names = await readdir(mediaDirectory).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
          throw error;
        });
        for (const name of names.filter(name => name === input.referenceId || name.startsWith(`${input.referenceId}.`) && name.endsWith(".deleted"))) {
          try {
            await unlink(join(mediaDirectory, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ClimbingError("Workspace could not finish removing this media file. Try again.", 500, "media_delete_failed");
          }
        }
        return { state: current, replayed: true };
      }
      if (existing.goalId !== input.goalId) throw new ClimbingError("This media reference belongs to another goal.", 409, "reference_conflict");
      const next = climbingStateSchema.parse({ ...current, revision: current.revision + 1, goalReferences: current.goalReferences.filter(reference => reference.id !== existing.id) });
      if (existing.kind === "link") {
        await writePrivateJson(file, next);
        return { state: next, replayed: false };
      }
      const mediaPath = join(mediaDirectory, existing.id);
      const quarantinedPath = join(mediaDirectory, `${existing.id}.${input.requestId}.deleted`);
      let quarantined = false;
      try {
        await rename(mediaPath, quarantinedPath);
        quarantined = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ClimbingError("Workspace could not secure this media file for removal. The reference was kept.", 500, "media_delete_failed");
      }
      try {
        await writePrivateJson(file, next);
      } catch (error) {
        if (quarantined) await rename(quarantinedPath, mediaPath);
        throw error;
      }
      if (quarantined) {
        try {
          await unlink(quarantinedPath);
        } catch {
          try {
            await rename(quarantinedPath, mediaPath);
            const restored = climbingStateSchema.parse({ ...current, revision: next.revision + 1 });
            await writePrivateJson(file, restored);
          } catch {
            mediaReady = undefined;
            throw new ClimbingError("Workspace could not finish removing this media file. Restart Workspace to reconcile its private media storage.", 500, "media_delete_failed");
          }
          throw new ClimbingError("Workspace could not remove this media file. The reference was restored so you can try again.", 500, "media_delete_failed");
        }
      }
      return { state: next, replayed: false };
    });
  }

  async function serveMedia(req: IncomingMessage, res: ServerResponse, referenceId: string) {
    identifierSchema.parse(referenceId);
    const state = await read();
    const reference = state.goalReferences.find(item => item.id === referenceId);
    if (!reference || reference.kind === "link" || !reference.fileName) throw new ClimbingError("This goal media is no longer available.", 404, "media_not_found");
    const mediaPath = join(mediaDirectory, reference.id);
    let info;
    let prefix;
    try {
      [info, prefix] = await Promise.all([stat(mediaPath), readPrefix(mediaPath)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ClimbingError("This goal media is no longer available.", 404, "media_not_found");
      throw error;
    }
    const detected = mediaType(prefix, info.size);
    if (!info.isFile() || !detected || detected.kind !== reference.kind || detected.mimeType !== reference.mimeType || info.size !== reference.byteSize) throw new ClimbingError("Workspace could not verify this saved media file.", 500, "media_inconsistent");
    const rangeValue = header(req, "range");
    let range: { start: number; end: number } | undefined;
    if (rangeValue) {
      try {
        range = parseRange(rangeValue, info.size);
      } catch (error) {
        res.setHeader("Content-Range", `bytes */${info.size}`);
        throw error;
      }
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    res.statusCode = range ? 206 : 200;
    res.setHeader("Content-Type", detected.mimeType);
    res.setHeader("Content-Length", String(end - start + 1));
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", dispositionFileName(reference.fileName));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
    if (req.method === "HEAD") return res.end();
    const stream = createReadStream(mediaPath, { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const host = req.headers.host || "";
      if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") {
        throw new ClimbingError("Only this local Workspace can access your climbing log.", 403);
      }
      await ensureMediaReady();
      const path = requestPath(req);
      const mediaMatch = /^\/media\/([0-9a-f-]+)$/i.exec(path);
      if (mediaMatch && (req.method === "GET" || req.method === "HEAD")) {
        await serveMedia(req, res, mediaMatch[1]);
        return;
      }
      if (path === "/media/link" && req.method === "POST") {
        const result = await addLink(req);
        send(res, 200, result.state, { ETag: `"climbing-${result.state.revision}"`, ...(result.replayed ? { "X-Idempotent-Replay": "true" } : {}) });
        return;
      }
      if (path === "/media/upload" && req.method === "POST") {
        const result = await addUpload(req);
        send(res, 200, result.state, { ETag: `"climbing-${result.state.revision}"`, ...(result.replayed ? { "X-Idempotent-Replay": "true" } : {}) });
        return;
      }
      if (path === "/media/delete" && req.method === "POST") {
        const result = await deleteReference(req);
        send(res, 200, result.state, { ETag: `"climbing-${result.state.revision}"`, ...(result.replayed ? { "X-Idempotent-Replay": "true" } : {}) });
        return;
      }
      if (path !== "/") throw new ClimbingError("Unknown climbing endpoint.", 404);
      if (req.method === "GET") {
        const state = await read();
        const etag = `"climbing-${state.revision}"`;
        if (req.headers["if-none-match"] === etag) send(res, 304, undefined, { ETag: etag });
        else send(res, 200, state, { ETag: etag, "X-Climbing-Revision": String(state.revision) });
        return;
      }
      if (req.method !== "PUT" && req.method !== "POST") throw new ClimbingError("Method not allowed.", 405);
      const raw = await jsonBody(req);
      if (req.method === "POST") {
        const result = await exclusive(async () => {
          const current = await read();
          const input = climbingCommandSchema.parse(preserveCommandGoalFields(raw, current));
          const applied = applyCommand(current, input);
          if (!applied.replayed) await writePrivateJson(file, applied.state);
          return applied;
        });
        send(res, 200, result.state, { ETag: `"climbing-${result.state.revision}"`, ...(result.replayed ? { "X-Idempotent-Replay": "true" } : {}) });
        return;
      }
      const saved = await exclusive(async () => {
        const current = await read();
        const input = climbingStateSchema.parse(preserveStateGoalFields(raw, current));
        if (input.revision !== current.revision) throw new ClimbingError("Your climbing log changed in another window. Your open draft is still here; review the latest saved records before trying again.", 409, "revision_conflict");
        const next = climbingStateSchema.parse({ ...input, goalReferences: current.goalReferences, revision: current.revision + 1 });
        await writePrivateJson(file, next);
        return next;
      });
      send(res, 200, saved, { ETag: `"climbing-${saved.revision}"` });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(
        res,
        error instanceof ClimbingError ? error.status : error instanceof StoreBusyError ? 423 : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500,
        {
          code: error instanceof ClimbingError ? error.code : error instanceof StoreBusyError ? "store_busy" : error instanceof z.ZodError || error instanceof SyntaxError ? "invalid_state" : "save_failed",
          error: error instanceof ClimbingError || error instanceof StoreBusyError ? error.message : error instanceof z.ZodError ? error.issues[0]?.message : "Your climbing update could not be saved. Your existing log has been kept.",
        },
      );
    }
  }

  return { handle };
}

export function climbing(): Plugin {
  const service = createClimbingService(process.env.WORKSPACE_DATA_DIR || join(homedir(), "Data/personal-workspace"));
  return { name: "workspace-climbing", configureServer(server) { server.middlewares.use("/api/climbing", service.handle); } };
}
