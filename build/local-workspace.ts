import { mkdir, readFile, rename, writeFile, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { emptyWorkspace, workspaceSchema, type Workspace } from "../lib/workspace.ts";

export function localWorkspace(): Plugin {
  const directory = process.env.WORKSPACE_DATA_DIR || join(homedir(), "Data", "personal-workspace");
  const file = join(directory, "workspace.json");
  let queue: Promise<unknown> = Promise.resolve();
  async function read(): Promise<Workspace> {
    try { return workspaceSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(emptyWorkspace); throw error; }
  }
  return {
    name: "personal-workspace-local-data",
    configureServer(server) {
      server.middlewares.use("/api/workspace", async (req, res) => {
        const host = req.headers.host || "";
        const origin = req.headers.origin;
        const send = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(data)); };
        if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host) || (origin && origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") { send(403, { error: "Only this local workspace can access its data." }); return; }
        if (req.method === "GET") {
          try { send(200, await read()); } catch { send(500, { error: "Your saved workspace could not be read. Its file has been left untouched." }); } return;
        }
        if (req.method !== "PUT") { send(405, { error: "Method not allowed" }); return; }
        if (!req.headers["content-type"]?.startsWith("application/json")) { send(415, { error: "JSON is required" }); return; }
        let length = 0; const chunks: Buffer[] = [];
        try {
          for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 2_000_000) { send(413, { error: "This workspace is too large to save." }); return; } chunks.push(bytes); }
          const parsed = workspaceSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (!parsed.success) { send(400, { error: "Check the title, date, and times before saving." }); return; }
          const next = parsed.data;
          queue = queue.catch(() => {}).then(async () => {
            let lock: Awaited<ReturnType<typeof open>> | undefined;
            const lockPath = join(directory, ".write-lock");
            const tempPath = join(directory, `workspace.${process.pid}.tmp`);
            try {
              await mkdir(directory, { recursive: true, mode: 0o700 });
              try { lock = await open(lockPath, "wx", 0o600); await lock.writeFile(String(process.pid)); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { send(409, { error: "The workspace is busy. Try again. If a save was interrupted and this continues, follow the recovery steps in the project README." }); return; } throw error; }
              const current = await read();
              if (next.revision !== current.revision) { send(409, { error: "Your workspace changed in another window. The latest version is loaded; your draft is still here. Save again to apply it." }); return; }
              next.revision = current.revision + 1;
              await writeFile(join(directory, "workspace.backup.json"), JSON.stringify(current, null, 2), { mode: 0o600 });
              const temp = await open(tempPath, "w", 0o600);
              try { await temp.writeFile(JSON.stringify(next, null, 2)); await temp.sync(); } finally { await temp.close(); }
              await rename(tempPath, file);
              send(200, next);
            } catch { send(500, { error: "Your changes could not be saved. Your previous data and current draft are still available. Try again." }); }
            finally { if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); } await unlink(tempPath).catch(() => {}); }
          });
          await queue;
        } catch { send(400, { error: "This change could not be read. Please try again." }); }
      });
    },
  };
}
