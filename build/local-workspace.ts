import { mkdir, readFile, rename, writeFile, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { emptyWorkspace, workspaceCommandSchema, workspaceSchema, type Item, type Workspace, type WorkspaceCommand } from "../lib/workspace.ts";

class StoreBusyError extends Error {}

const itemContent = (item: Item) => JSON.stringify({
  kind: item.kind,
  title: item.title,
  area: item.area,
  date: item.date,
  time: item.time,
  endTime: item.endTime,
  done: item.done,
  triageStatus: item.triageStatus,
});

const now = () => new Date().toISOString();

export function localWorkspace(): Plugin {
  const directory = process.env.WORKSPACE_DATA_DIR || join(homedir(), "Data", "personal-workspace");
  const file = join(directory, "workspace.json");
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<Workspace> {
    try { return workspaceSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(emptyWorkspace); throw error; }
  }
  async function acquireLock() {
    const lockPath = join(directory, ".write-lock");
    const attempt = async () => {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }));
      return lock;
    };
    try { return await attempt(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const [details, lockStat] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
        let pid = Number(details);
        try {
          const parsed = JSON.parse(details) as { pid?: unknown };
          pid = typeof parsed.pid === "number" ? parsed.pid : pid;
        } catch {}
        const hasOwner = Number.isInteger(pid) && pid > 0;
        let running: boolean | null = hasOwner ? true : null;
        if (hasOwner) try { process.kill(pid, 0); } catch (cause) { running = (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
        const age = Date.now() - lockStat.mtimeMs;
        if ((running === false && age > 5_000) || (running === null && age > 5 * 60_000)) {
          await unlink(lockPath);
          return await attempt();
        }
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "ENOENT") return await attempt();
        throw retryError;
      }
      throw new StoreBusyError();
    }
  }
  async function persist(current: Workspace, next: Workspace) {
    const lockPath = join(directory, ".write-lock");
    const tempPath = join(directory, `workspace.${process.pid}.${crypto.randomUUID()}.tmp`);
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      lock = await acquireLock();
      const latest = await read();
      if (latest.revision !== current.revision) return { conflict: latest } as const;
      await writeFile(join(directory, "workspace.backup.json"), JSON.stringify(latest, null, 2), { mode: 0o600 });
      const temp = await open(tempPath, "w", 0o600);
      try { await temp.writeFile(JSON.stringify(next, null, 2)); await temp.sync(); } finally { await temp.close(); }
      await rename(tempPath, file);
      return { saved: next } as const;
    } finally {
      if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); }
      await unlink(tempPath).catch(() => {});
    }
  }
  function mergeWholeDocument(current: Workspace, incoming: Workspace, raw: unknown): Workspace {
    const stamp = now();
    const rawItems = typeof raw === "object" && raw !== null && "items" in raw && Array.isArray(raw.items) ? raw.items : [];
    const rawById = new Map(rawItems.filter(value => typeof value === "object" && value !== null && typeof value.id === "string").map(value => [value.id as string, value as Record<string, unknown>]));
    const currentById = new Map(current.items.map(item => [item.id, item]));
    const items = incoming.items.map(item => {
      const previous = currentById.get(item.id);
      const rawItem = rawById.get(item.id);
      const triageStatus = item.kind === "note"
        ? rawItem && Object.hasOwn(rawItem, "triageStatus") ? item.triageStatus : previous?.triageStatus ?? "new"
        : null;
      const candidate = { ...item, triageStatus };
      if (!previous) { const deleted = current.tombstones.find(entry => entry.id === item.id); return { ...candidate, revision: (deleted?.revision ?? 0) + 1, createdAt: item.createdAt ?? stamp, updatedAt: stamp }; }
      const changed = itemContent(candidate) !== itemContent(previous);
      return {
        ...candidate,
        revision: changed ? previous.revision + 1 : previous.revision,
        createdAt: rawItem && Object.hasOwn(rawItem, "createdAt") ? item.createdAt : previous.createdAt,
        updatedAt: changed ? stamp : previous.updatedAt,
      };
    });
    const incomingIds = new Set(items.map(item => item.id));
    const deleted = current.items.filter(item => !incomingIds.has(item.id));
    return {
      version: 2,
      revision: current.revision + 1,
      items,
      tombstones: [
        ...current.tombstones.filter(entry => !items.some(item => item.id === entry.id)),
        ...deleted.map(item => ({ id: item.id, revision: item.revision + 1, deletedAt: stamp })),
      ].slice(-10000),
      receipts: current.receipts,
    };
  }
  function applyCommand(current: Workspace, command: WorkspaceCommand, payloadHash: string): Workspace | { conflict: string } {
    const itemId = "item" in command ? command.item.id : command.id;
    const existing = current.items.find(item => item.id === itemId);
    const deleted = current.tombstones.find(entry => entry.id === itemId);
    const expected = "expectedItemRevision" in command ? command.expectedItemRevision : null;
    if (command.action === "upsert") {
      if (deleted || (expected === null && existing) || (expected !== null && (!existing || existing.revision !== expected))) return { conflict: "This item changed on another device." };
    } else if (command.action === "restore") {
      if (existing || !deleted || deleted.revision !== command.expectedTombstoneRevision) return { conflict: "This deleted item changed on another device." };
    } else if (!existing || existing.revision !== expected) return { conflict: "This item changed on another device." };
    const stamp = now();
    const workspaceRevision = current.revision + 1;
    let items = current.items;
    let tombstones = current.tombstones;
    if (command.action === "upsert" || command.action === "restore") {
      const nextItem: Item = {
        ...command.item,
        revision: command.action === "restore" ? deleted!.revision + 1 : (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? command.item.createdAt ?? stamp,
        updatedAt: stamp,
        triageStatus: command.item.kind === "note" ? existing?.triageStatus ?? command.item.triageStatus ?? "new" : null,
      };
      items = existing ? items.map(item => item.id === nextItem.id ? nextItem : item) : [...items, nextItem];
      tombstones = tombstones.filter(entry => entry.id !== nextItem.id);
    } else if (command.action === "delete") {
      items = items.filter(item => item.id !== command.id);
      tombstones = [...tombstones.filter(entry => entry.id !== command.id), { id: command.id, revision: existing!.revision + 1, deletedAt: stamp }].slice(-10000);
    } else if (command.action === "toggle") {
      items = items.map(item => item.id === command.id ? { ...item, done: command.done, revision: item.revision + 1, updatedAt: stamp } : item);
    } else {
      if (existing!.kind !== "note") return { conflict: "Only captures have a triage state." };
      items = items.map(item => item.id === command.id ? { ...item, triageStatus: command.status, revision: item.revision + 1, updatedAt: stamp } : item);
    }
    return {
      version: 2,
      revision: workspaceRevision,
      items,
      tombstones,
      receipts: [...current.receipts, { requestId: command.requestId, action: command.action, itemId, payloadHash, workspaceRevision, completedAt: stamp }].slice(-500),
    };
  }
  return {
    name: "personal-workspace-local-data",
    configureServer(server) {
      server.middlewares.use("/api/workspace", async (req, res) => {
        const host = req.headers.host || "";
        const origin = req.headers.origin;
        const send = (status: number, data?: unknown, headers: Record<string, string> = {}) => { res.statusCode = status; for (const [key, value] of Object.entries(headers)) res.setHeader(key, value); if (status !== 304) { res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(data)); } else res.end(); };
        if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host) || (origin && origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") { send(403, { error: "Only this local workspace can access its data." }); return; }
        if (req.method === "GET") {
          try {
            const state = await read();
            const etag = `"workspace-${state.revision}"`;
            if (req.headers["if-none-match"] === etag) send(304, undefined, { ETag: etag });
            else send(200, state, { ETag: etag, "X-Workspace-Revision": String(state.revision) });
          } catch { send(500, { error: "Your saved workspace could not be read. Its file has been left untouched." }); }
          return;
        }
        if (req.method !== "PUT" && req.method !== "POST") { send(405, { error: "Method not allowed" }); return; }
        if (!req.headers["content-type"]?.startsWith("application/json")) { send(415, { error: "JSON is required" }); return; }
        let length = 0; const chunks: Buffer[] = [];
        try {
          for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 2_000_000) { send(413, { error: "This workspace is too large to save." }); return; } chunks.push(bytes); }
          const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const parsed = (req.method === "POST" ? workspaceCommandSchema : workspaceSchema).safeParse(raw);
          if (!parsed.success) { send(400, { error: "Check the title, date, and times before saving." }); return; }
          queue = queue.catch(() => {}).then(async () => {
            try {
              const current = await read();
              if (req.method === "PUT" && (parsed.data as Workspace).revision !== current.revision) { send(409, { code: "revision_conflict", error: "Your workspace changed in another window. The latest version is loaded; your draft is still here. Save again to apply it.", state: current }); return; }
              if (req.method === "POST") {
                const command = parsed.data as WorkspaceCommand;
                const payloadHash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
                const receipt = current.receipts.find(value => value.requestId === command.requestId);
                if (receipt) {
                  if (receipt.payloadHash !== payloadHash) { send(409, { code: "request_id_conflict", error: "This save key was already used for a different change. Retry with a fresh save key.", state: current }); return; }
                  send(200, current, { "X-Idempotent-Replay": "true" }); return;
                }
                const applied = applyCommand(current, command, payloadHash);
                if ("conflict" in applied) { send(409, { code: "item_revision_conflict", error: applied.conflict, state: current }); return; }
                const result = await persist(current, applied);
                if ("conflict" in result) { send(409, { code: "revision_conflict", error: "Your workspace changed while this item was saving. The latest version is loaded; try again.", state: result.conflict }); return; }
                send(200, result.saved, { ETag: `"workspace-${result.saved.revision}"` });
                return;
              }
              const next = mergeWholeDocument(current, parsed.data as Workspace, raw);
              const result = await persist(current, next);
              if ("conflict" in result) { send(409, { code: "revision_conflict", error: "Your workspace changed in another window. The latest version is loaded; your draft is still here. Save again to apply it.", state: result.conflict }); return; }
              send(200, result.saved, { ETag: `"workspace-${result.saved.revision}"` });
            } catch (error) {
              if (error instanceof StoreBusyError) { send(409, { code: "store_busy", error: "The workspace is busy. Try again. If a save was interrupted and this continues, follow the recovery steps in the project README." }); return; }
              send(500, { error: "Your changes could not be saved. Your previous data and current draft are still available. Try again." });
            }
          });
          await queue;
        } catch { send(400, { error: "This change could not be read. Please try again." }); }
      });
    },
  };
}
