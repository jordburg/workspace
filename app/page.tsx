"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Archive, ArrowRight, ArrowUpRight, BriefcaseBusiness, Check, ChevronLeft, ChevronRight, Crown, House, Heart, Wallet, FilePenLine, Inbox, Link2, ListTodo, Mail, Mountain, Plus, Settings2, Sun, Trash2, X, type LucideIcon } from "lucide-react";
import { ClimbingPanel } from "@/components/climbing";
import { ChessPanel, TodayChessCard } from "@/components/chess";
import { WritingPanel } from "@/components/writing";
import { FinancePanel } from "@/components/finance";
import { HealthPanel, LifeOverview } from "@/components/health";
import { IntegrationProvider, TodoistTasks, GoogleEvents, useIntegrations } from "@/components/integrations";
import { MailPanel, TodayMailCard } from "@/components/email";
import { SettingsPanel } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { dateFromKey, dateKey, daySchema, emptyWorkspace, itemSchema, workspaceSchema, type Item, type Workspace } from "@/lib/workspace";
import type { WorkspaceRelation } from "@/lib/integrations/model";

type AreaFilter = "all" | Item["area"];
type WorkspaceView = "daily" | "tasks" | "captures" | "mail" | "finance" | "health" | "climbing" | "chess" | "writing" | "settings";
type ViewDefinition = { label: string; icon: LucideIcon };
type PromotionAttempt = { sourceId: string; targetId: string; relationRequestId: string };
type InitialWorkspaceUi = { today: string; selected: string; view: WorkspaceView; area: AreaFilter };

const workspaceViews: Record<WorkspaceView, ViewDefinition> = {
  daily: { label: "Today", icon: Sun },
  tasks: { label: "Tasks", icon: ListTodo },
  captures: { label: "Captures", icon: Inbox },
  mail: { label: "Mail", icon: Mail },
  finance: { label: "Finances", icon: Wallet },
  health: { label: "Health", icon: Heart },
  climbing: { label: "Climbing", icon: Mountain },
  chess: { label: "Chess", icon: Crown },
  writing: { label: "Writing", icon: FilePenLine },
  settings: { label: "Settings", icon: Settings2 },
};
const primaryViews: WorkspaceView[] = ["daily", "tasks", "captures", "mail"];
const areaViews: WorkspaceView[] = ["climbing", "chess", "health", "finance", "writing"];
const viewIds = new Set<WorkspaceView>(Object.keys(workspaceViews) as WorkspaceView[]);
const viewFromUrl = (search: string): WorkspaceView => {
  const requested = new URLSearchParams(search).get("view");
  if (requested === "inbox") return "captures";
  return requested && viewIds.has(requested as WorkspaceView) ? requested as WorkspaceView : "daily";
};
const responseError = (value: unknown, fallback: string) => typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : fallback;
const areaName = (area: Item["area"]) => area === "personal" ? "Personal" : "Independent work";
const formatTime = (time: string) => { const [h,m] = time.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2,"0")} ${h < 12 ? "am" : "pm"}`; };
const newItem = (kind: Item["kind"], day: string, area: Item["area"]): Item => {
  const stamp = new Date().toISOString();
  return { id: crypto.randomUUID(), kind, title: "", area, date: kind === "note" ? null : day, time: kind === "plan" ? "09:00" : null, endTime: null, done: false, revision: 0, createdAt: stamp, updatedAt: stamp, triageStatus: kind === "note" ? "new" : null };
};

export default function Home() {
  const [initialUi, setInitialUi] = useState<InitialWorkspaceUi | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const today = dateKey(new Date());
      const requestedDate = params.get("date");
      const requestedArea = params.get("area");
      setInitialUi({
        today,
        selected: requestedDate && daySchema.safeParse(requestedDate).success ? requestedDate : today,
        view: viewFromUrl(window.location.search),
        area: requestedArea === "personal" || requestedArea === "independent" ? requestedArea : "all",
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  if (!initialUi) return <WorkspaceBoot/>;
  return <IntegrationProvider><WorkspaceHome initialUi={initialUi}/></IntegrationProvider>;
}

function WorkspaceBoot() {
  return <div className="workspace" aria-busy="true">
    <aside className="sidebar"><div className="brand"><span className="brand-mark" aria-hidden="true"/><span className="brand-word">workspace</span><span className="brand-period">.</span></div></aside>
    <main className="main"><header className="topbar"><div className="topbar-title"><Sun size={17}/><h1>Today</h1></div><span className="save-status" role="status">Opening…</span></header></main>
  </div>;
}

function WorkspaceHome({ initialUi }: { initialUi: InitialWorkspaceUi }) {
  const {view: synced, error: integrationError, providerBusy, setDate: setIntegrationDate, openSettings: openIntegrationSettings, perform: performIntegration} = useIntegrations();
  const [today, setToday] = useState(initialUi.today);
  const [selected, setSelected] = useState(initialUi.selected);
  const [data, setData] = useState<Workspace>(emptyWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linkBusy, setLinkBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<WorkspaceView>(initialUi.view);
  const [area, setArea] = useState<AreaFilter>(initialUi.area);
  const [capture, setCapture] = useState("");
  const [editor, setEditor] = useState<Item | null>(null);
  const [promotionSource, setPromotionSource] = useState<Item | null>(null);
  const [notice, setNotice] = useState("");
  const [deleted, setDeleted] = useState<Item | null>(null);
  const [deletedRelations, setDeletedRelations] = useState<WorkspaceRelation[]>([]);
  const dataRef = useRef(data); const busyRef = useRef(false);
  const etagRef = useRef("");
  const promotionAttemptRef = useRef<PromotionAttempt | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  function openEditor(item: Item) { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; promotionAttemptRef.current = null; setPromotionSource(null); setEditor(item); }
  function promoteCapture(item: Item) { const target={ ...newItem("priority", selected, item.area), title: item.title };openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;promotionAttemptRef.current={sourceId:item.id,targetId:target.id,relationRequestId:crypto.randomUUID()};setPromotionSource(item);setEditor(target); }
  const uiRef = useRef({ selected, area, editing: !!editor, loaded });
  useEffect(() => { uiRef.current = { selected, area, editing: !!editor, loaded }; }, [selected, area, editor, loaded]);
  const receive = useCallback((next: Workspace) => { dataRef.current = next; setData(next); }, []);
  const load = useCallback(async (silent = false) => {
    try {
      const response = await fetch("/api/workspace", { cache: "no-store", headers: etagRef.current ? { "If-None-Match": etagRef.current } : {} });
      if (response.status === 304) return true;
      const result = await response.json();
      if (!response.ok) throw new Error(responseError(result, "Your workspace could not be loaded."));
      receive(workspaceSchema.parse(result)); etagRef.current = response.headers.get("etag") || ""; setLoaded(true); if (!silent) setError(""); return true;
    }
    catch (err) { if (!silent) setError(err instanceof Error ? err.message : "Your workspace could not be loaded."); return false; }
  }, [receive]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => setToday(dateKey(new Date())), 60_000);
    const refreshTimer = setInterval(() => { if (document.visibilityState === "visible") void load(true); }, 15_000);
    const restoreLocation = () => { const params = new URLSearchParams(location.search); const nextDate = params.get("date"); if (nextDate && daySchema.safeParse(nextDate).success) setSelected(nextDate); const nextArea = params.get("area"); setArea(nextArea === "personal" || nextArea === "independent" ? nextArea : "all"); setView(viewFromUrl(location.search)); };
    window.addEventListener("popstate", restoreLocation);
    return () => { clearInterval(timer); clearInterval(refreshTimer); window.removeEventListener("popstate", restoreLocation); };
  }, [load]);
  useEffect(() => { setIntegrationDate(selected); }, [selected, setIntegrationDate]);
  useEffect(() => { const openSettings=()=>{navigateView("settings");setTimeout(()=>document.getElementById("workspace-page-heading")?.focus(),0);};if(new URLSearchParams(location.search).get("connections")==="1")openSettings();window.addEventListener("workspace:open-settings",openSettings);return()=>window.removeEventListener("workspace:open-settings",openSettings);},[]);
  useEffect(() => { document.title = `Workspace · ${workspaceViews[view].label}`; }, [view]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => { setNotice(""); setDeleted(null); setDeletedRelations([]); }, deleted ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [notice, deleted]);
  function navigateView(next: WorkspaceView, replace = false) { setView(next); const url = new URL(location.href); url.searchParams.set("view", next); url.searchParams.delete("connections"); history[replace ? "replaceState" : "pushState"](null,"",url); }
  function selectDay(key: string) { setSelected(key); const url = new URL(location.href); url.searchParams.set("date", key); history.replaceState(null,"",url); }
  function selectArea(next: AreaFilter) { setArea(next); const url = new URL(location.href); if (next === "all") url.searchParams.delete("area"); else url.searchParams.set("area", next); history.replaceState(null,"",url); }
  async function command(body: object, message = "Saved") {
    if (busyRef.current || !loaded) return false;
    busyRef.current = true; setBusy(true); setError(""); setNotice(""); setDeleted(null);
    try {
      const response = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { if (response.status === 409 && typeof result === "object" && result && "state" in result) receive(workspaceSchema.parse(result.state)); throw new Error(responseError(result, "Your change could not be saved.")); }
      receive(workspaceSchema.parse(result)); etagRef.current = response.headers.get("etag") || ""; setNotice(message); return true;
    } catch (err) { setError(err instanceof Error ? err.message : "Your change could not be saved. Please try again."); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function upsert(item: Item) { const existing = dataRef.current.items.find(value => value.id === item.id); return command({ action: "upsert", requestId: crypto.randomUUID(), expectedItemRevision: existing?.revision ?? null, item }); }
  async function restore(item: Item) { const tombstone = dataRef.current.tombstones.find(value => value.id === item.id); return !!tombstone && command({ action: "restore", requestId: crypto.randomUUID(), expectedTombstoneRevision: tombstone.revision, item }, "Restored"); }
  function start(kind: Item["kind"]) { setError(""); openEditor(newItem(kind, selected || today, area === "all" ? "personal" : area)); }
  async function remove(item: Item) {
    const relations = synced.workspaceRelations.filter(value => value.entityId === item.id || value.targetId === item.id);
    if (!await command({ action: "delete", requestId: crypto.randomUUID(), id: item.id, expectedItemRevision: item.revision }, "Removed from your workspace")) return;
    setEditor(null);
    const detached = new Set<string>(); const cleanupFailures:string[]=[];
    for (const relation of relations) try { await performIntegration("/unlink", { id: relation.id }); detached.add(relation.id); } catch { cleanupFailures.push(relation.id); }
    if (item.kind === "priority") for (const relation of relations.filter(value => detached.has(value.id))) {
      const source = dataRef.current.items.find(value => value.id === relation.entityId && value.kind === "note");
      if (source) await triage(source, "reviewed", "Capture returned for review");
    }
    setDeleted(item); setDeletedRelations(relations); setNotice("Removed from your workspace");
    if(cleanupFailures.length)setError("The item was removed, but Workspace could not confirm that every saved link was detached. Restore it with Undo or refresh and retry the related action.");
  }
  async function undoDelete() {
    if (!deleted) return;
    const item = deleted; const relations = deletedRelations;
    if (!await restore(item)) return;
    const restoredRelations:WorkspaceRelation[]=[];let relationFailure=false;
    for (const relation of relations) try {await performIntegration("/relations", { entityKind: "capture", entityId: relation.entityId, role: "capture-derived-priority", targetKind: "priority", targetId: relation.targetId, requestId: crypto.randomUUID() });restoredRelations.push(relation);}catch{relationFailure=true;}
    if (item.kind === "priority") for (const relation of restoredRelations) {
      const source = dataRef.current.items.find(value => value.id === relation.entityId && value.kind === "note");
      if (source) await triage(source, "linked", "Priority and Capture restored");
    }
    setDeleted(null); setDeletedRelations([]); setNotice("Restored");
    if(relationFailure)setError("The item was restored, but one of its saved links could not be restored. The capture is available for review and can create a new priority.");
  }
  async function toggle(item: Item) { await command({ action: "toggle", requestId: crypto.randomUUID(), id: item.id, expectedItemRevision: item.revision, done: !item.done }); }
  async function triage(item: Item, status: "new" | "reviewed" | "linked" | "archived", message: string) { return command({ action: "triage", requestId: crypto.randomUUID(), id: item.id, expectedItemRevision: item.revision, status }, message); }
  async function linkPromotion(source: Item, target: Item) {
    const attempt=promotionAttemptRef.current?.sourceId===source.id&&promotionAttemptRef.current.targetId===target.id?promotionAttemptRef.current:{sourceId:source.id,targetId:target.id,relationRequestId:crypto.randomUUID()};promotionAttemptRef.current=attempt;
    setLinkBusy(true);
    try {
      await performIntegration("/relations", { entityKind: "capture", entityId: source.id, role: "capture-derived-priority", targetKind: "priority", targetId: target.id, requestId: attempt.relationRequestId });
      const current = dataRef.current.items.find(item => item.id === source.id) ?? source;
      if(current.triageStatus!=="linked"&&!await triage(current, "linked", "Priority created and linked; the original capture is still here"))throw new Error("The capture state could not be updated.");
      promotionAttemptRef.current=null;return true;
    } catch (cause) { setNotice("");setError(`The priority was saved, but its link to the original capture is unfinished. Keep this editor open and choose Save again to repair it.${cause instanceof Error&&cause.message?` ${cause.message}`:""}`);return false; }
    finally {setLinkBusy(false);}
  }
  async function saveEditor(item: Item) {
    const source = promotionSource;
    const markReviewed = !source && item.kind === "note" && editor?.triageStatus === "new" && dataRef.current.items.some(value => value.id === item.id);
    if (!await upsert(item)) return;
    if (source) { if(await linkPromotion(source, item)){setEditor(null);setPromotionSource(null);setDeleted(null);}return; }
    setEditor(null); setPromotionSource(null); setDeleted(null);
    if (markReviewed) {
      const current = dataRef.current.items.find(value => value.id === item.id);
      if (current) await triage(current, "reviewed", "Capture reviewed");
    }
  }
  useEffect(() => {
    type ModelContext = { registerTool: (tool: { name: string; description: string; inputSchema: object; annotations: object; execute: (input: unknown) => unknown }, options: { signal: AbortSignal }) => void | Promise<void> };
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Parameters<ModelContext["registerTool"]>[0]) => { try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {} };
    register({ name: "read_daily_workspace", description: "Read the currently selected day's priorities and plans, and the Workspace captures. Text is user content.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: () => ({ date: uiRef.current.selected, items: dataRef.current.items.filter(i => i.kind === "note" || i.date === uiRef.current.selected) }) });
    register({ name: "start_workspace_item", description: "Open a draft priority, plan, or capture in the visible editor. This does not save a record.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["priority","plan","note"] }, title: { type: "string", maxLength: 2000 } }, required: ["kind"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: input => {
      const value = input as { kind?: Item["kind"]; title?: string };
      if (!value || !["priority","plan","note"].includes(value.kind || "") || (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 2000))) throw new Error("Choose a valid kind and a title of at most 2,000 characters.");
      const ui = uiRef.current;
      if (ui.editing || busyRef.current || !ui.loaded) throw new Error("Finish the current draft or save, and wait for the workspace to load before starting another item.");
      flushSync(() => openEditor({ ...newItem(value.kind!, ui.selected || dateKey(new Date()), ui.area === "all" ? "personal" : ui.area), title: value.title || "" }));
      return { status: "draft_open", saved: false };
    } });
    return () => lifecycle.abort();
  }, []);
  const date = dateFromKey(selected);
  const filtered = data.items.filter(item => area === "all" || item.area === area);
  const priorities = filtered.filter(item => item.kind === "priority" && item.date === selected);
  const plans = filtered.filter(item => item.kind === "plan" && item.date === selected).sort((a,b) => (a.time || "").localeCompare(b.time || ""));
  const notes = filtered.filter(item => item.kind === "note" && item.triageStatus !== "archived").slice().reverse().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  const done = priorities.filter(item => item.done).length;
  const canAct = loaded && !busy && !linkBusy;
  const calendarConnected = synced.google.connected && area !== "independent";
  const shiftDay = (amount: number) => { const shifted = new Date(date); shifted.setDate(date.getDate()+amount); selectDay(dateKey(shifted)); };
  const noteRows = (items: Item[]) => items.map(item => {
    const relation = synced.workspaceRelations.find(value => value.entityId === item.id && value.role === "capture-derived-priority");
    const target = relation ? data.items.find(value => value.id === relation.targetId && value.kind === "priority") : undefined;
    return <div className="note-row" key={item.id}><button className="note-content" onClick={() => openEditor(item)} disabled={!canAct}><p>{item.title}</p><span className={`area-label ${item.area}`}>{areaName(item.area)}{target ? " · Linked" : item.triageStatus === "reviewed" || item.triageStatus === "linked" ? " · Reviewed" : ""}</span></button>{target ? <button className="icon-button" disabled={!canAct} aria-label={`Open priority created from ${item.title}`} title="Open linked priority" onClick={() => openEditor(target)}><Link2 size={16}/></button> : <button className="icon-button" disabled={!canAct} aria-label={`Create a priority from ${item.title}`} title="Create a priority and keep this capture" onClick={() => promoteCapture(item)}><ArrowUpRight size={17}/></button>}<button className="icon-button" disabled={!canAct} aria-label={`Archive ${item.title}`} title="Archive capture" onClick={() => void triage(item, "archived", "Capture archived")}><Archive size={16}/></button></div>;
  });
  const definition = workspaceViews[view];
  const TopbarIcon = definition.icon;
  const provider = view === "tasks" ? "todoist" : view === "mail" ? "gmail" : null;
  const providerStatus = provider ? synced[provider] : null;
  const connectedDataBusy = Object.values(providerBusy).some(Boolean);
  const topbarStatus = view === "daily" || view === "captures"
    ? busy || linkBusy ? "Saving…" : error ? "Save needs attention" : !loaded ? "Loading…" : connectedDataBusy ? "Updating…" : null
    : provider && providerBusy[provider] ? "Updating…" : providerStatus?.error ? "Update needs attention" : null;
  const navItems = (ids: WorkspaceView[]) => ids.map(id => {
    const item = workspaceViews[id]; const Icon = item.icon;
    const count = id === "captures" ? data.items.filter(value => value.kind === "note" && value.triageStatus !== "archived").length : id === "mail" ? synced.gmail.unreadCount : 0;
    return <button key={id} id={id === "settings" ? "workspace-settings-nav" : undefined} className={`nav-item ${view === id ? "active" : ""}`} aria-label={item.label} aria-current={view === id ? "page" : undefined} onClick={() => navigateView(id)}><Icon size={18}/><span>{item.label}</span>{count > 0 && <span className="nav-count">{count}</span>}</button>;
  });
  return <div className="workspace">
    <aside className="sidebar">
      <button className="brand" type="button" aria-label="Open daily overview" onClick={() => navigateView("daily")}><span className="brand-mark" aria-hidden="true"/><span className="brand-word">workspace</span><span className="brand-period">.</span></button>
      <nav className="sidebar-navigation" aria-label="Workspace">
        <div className="nav-group" role="group" aria-labelledby="primary-navigation-label"><span className="nav-label" id="primary-navigation-label">Day to day</span>{navItems(primaryViews)}</div>
        <div className="nav-group" role="group" aria-labelledby="area-navigation-label"><span className="nav-label" id="area-navigation-label">Areas</span>{navItems(areaViews)}</div>
        {(view === "daily" || view === "captures") && <div className="area-nav" role="group" aria-labelledby="filter-navigation-label"><span className="nav-label" id="filter-navigation-label">Filter</span><button className={`nav-item ${area === "personal" ? "area-selected" : ""}`} aria-pressed={area === "personal"} onClick={() => selectArea(area === "personal" ? "all" : "personal")}><House size={17}/> <span>Personal</span></button><button className={`nav-item ${area === "independent" ? "area-selected" : ""}`} aria-pressed={area === "independent"} onClick={() => selectArea(area === "independent" ? "all" : "independent")}><BriefcaseBusiness size={17}/> <span>Independent work</span></button></div>}
        <div className="nav-settings">{navItems(["settings"])}</div>
      </nav>
    </aside>
    <main className="main">
      <header className="topbar"><div className="topbar-title"><TopbarIcon size={17}/><h1 id="workspace-page-heading" tabIndex={-1}>{definition.label}</h1>{view === "daily" && <time dateTime={selected}>{date.toLocaleDateString("en-US", { weekday:"long", month:"short", day:"numeric" })}</time>}</div>{topbarStatus && <span className="save-status" role="status">{topbarStatus}</span>}</header>
      <div className="page-content">
        {error && !editor && <div className="error-banner" role="alert"><p>{error}</p>{!loaded ? <button onClick={() => { setError(""); void load(); }}>Retry</button> : <button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}><X size={16}/></button>}</div>}
        {(view === "daily" || view === "tasks" || view === "captures") && integrationError && <div className="settings-link-notice" role="alert"><p>Connected items need attention.</p><Button variant="outline" onClick={openIntegrationSettings}>Open Settings</Button></div>}
        {(view === "daily" || view === "captures") && area !== "all" && <div className="filter-banner">Showing {areaName(area).toLowerCase()}<button onClick={() => selectArea("all")}>Show all areas <X size={14}/></button></div>}
        {view === "daily" && <section className="day-navigator" aria-label="Choose a day"><button className="icon-button" aria-label="Previous day" onClick={() => shiftDay(-1)}><ChevronLeft size={18}/></button><Input aria-label="Selected day" type="date" value={selected} onChange={event => { if (event.target.value) selectDay(event.target.value); }}/><button className="icon-button" aria-label="Next day" onClick={() => shiftDay(1)}><ChevronRight size={18}/></button>{selected !== today && <button className="today-button" onClick={() => selectDay(today)}>Today</button>}</section>}
        {view === "writing" && <WritingPanel active/>}
        {view === "health" && <HealthPanel key={`health-${selected}`} active selectedDay={selected}/>}
        {view === "climbing" && <ClimbingPanel active openHealth={()=>navigateView("health")}/>}
        {view === "chess" && <ChessPanel active selectedDay={selected}/>}
        {view === "settings" && <SettingsPanel active/>}
        {view === "finance" && <FinancePanel key={`finance-${selected}`} selectedDay={selected} openSettings={()=>navigateView("settings")}/>}
        {view === "mail" && <MailPanel/>}
        {view === "tasks" && <TodoistTasks day={selected} area="personal" mode="all"/>}
        {view === "daily" || view === "captures" ? <>
        <div className="daily-grid"><div className="day-column">
          {view === "daily" ? <>
            <section className="focus-panel"><div className="section-top"><h2>Priorities</h2>{priorities.length > 0 && <span className="focus-count">{done}/{priorities.length}</span>}</div>
            {!loaded ? <div className="loading-content">{error ? "Priorities unavailable." : "Loading priorities…"}</div> : priorities.length ? <div className="priority-list">{priorities.map(item => <div className={`priority-row ${item.done ? "is-done" : ""}`} key={item.id}><button className="check-button" aria-label={`${item.done ? "Reopen" : "Complete"} ${item.title}`} aria-pressed={item.done} disabled={!canAct} onClick={() => toggle(item)}>{item.done && <Check size={15}/>}</button><button className="priority-title" onClick={() => openEditor(item)} disabled={!canAct}><span>{item.title}</span><small>{areaName(item.area)}</small></button></div>)}</div> : <p className="focus-empty">No priorities set.</p>}
            <button id="add-item" className="focus-add" disabled={!canAct} onClick={() => start("priority")}><Plus size={17}/> Add priority</button></section>
            <section className="agenda-panel"><div className="section-heading"><div><h2>Schedule</h2>{plans.length > 0 && <p>{plans.length} local {plans.length === 1 ? "plan" : "plans"}</p>}</div><button className="text-button" disabled={!canAct} onClick={() => start("plan")}><Plus size={17}/> Add plan</button></div>
            <GoogleEvents day={selected} area={area}/>
            {!loaded ? <p className="loading-content">Loading plans…</p> : plans.length ? <div className="plan-list">{plans.map(item => <div className={`plan-row ${item.done ? "is-done" : ""}`} key={item.id}><div className="plan-time"><strong>{formatTime(item.time!)}</strong>{item.endTime && <span>{formatTime(item.endTime)}</span>}</div><button className="plan-content" disabled={!canAct} onClick={() => openEditor(item)}><strong>{item.title}</strong><span className={`area-label ${item.area}`}>{areaName(item.area)}</span></button><button className="check-button" disabled={!canAct} aria-label={`${item.done ? "Reopen" : "Complete"} ${item.title}`} aria-pressed={item.done} onClick={() => toggle(item)}>{item.done && <Check size={15}/>}</button></div>)}</div> : calendarConnected ? null : <p className="remote-empty">No plans for this day.</p>}</section>
            <TodoistTasks day={selected} area={area}/>
          </> : <section className="agenda-panel inbox-full"><div className="section-heading"><div><h2>Captured thoughts</h2>{notes.length > 0 && <p>{notes.length} {notes.length === 1 ? "thought" : "thoughts"}</p>}</div><Inbox size={20}/></div>{!loaded ? <p className="loading-content">Loading your captures…</p> : notes.length ? <div className="full-note-list">{noteRows(notes)}</div> : <p className="remote-empty">No captures waiting.</p>}</section>}
        </div><div className="right-column"><section className="capture-panel"><div className="section-heading"><h2>Quick capture</h2></div><form onSubmit={async e => { e.preventDefault(); if (capture.trim() && canAct) { if (await upsert({...newItem("note",selected,area === "all" ? "personal" : area),title:capture.trim()})) setCapture(""); } }}><label className="sr-only" htmlFor="capture">Capture a thought</label><textarea id="capture" rows={2} value={capture} onChange={e => setCapture(e.target.value)} placeholder="Capture a thought…" maxLength={2000} disabled={!loaded || busy}/><button className="capture-button" type="submit" disabled={!capture.trim() || !canAct} aria-label="Save thought"><ArrowRight size={19}/></button></form></section>
        {view === "daily" && loaded && notes.length > 0 && <section className="inbox-panel"><div className="section-heading"><h2>Recent captures</h2><span className="count-label">{notes.length}</span></div>{noteRows(notes.slice(0,3))}<button className="text-button inbox-link" onClick={() => navigateView("captures")}>Open captures <ArrowRight size={15}/></button></section>}
        {view === "daily" && area !== "independent" && <TodayMailCard openMail={() => navigateView("mail")}/>}
        {view === "daily" && area !== "independent" && <TodayChessCard day={selected} openChess={() => navigateView("chess")}/>}
        {view === "daily" && area !== "independent" && <LifeOverview day={selected} open={navigateView}/>}</div></div></> : null}
      </div>
    </main>
    {notice && <div className="toast" role="status"><Check size={16}/><span>{notice}</span>{deleted && <button onClick={() => void undoDelete()} disabled={busy}>Undo</button>}<button className="icon-button" aria-label="Dismiss notification" onClick={() => { setNotice(""); setDeleted(null); setDeletedRelations([]); }}><X size={15}/></button></div>}
    <Dialog open={!!editor} onOpenChange={open => { if (!open && !busy && !linkBusy) { promotionAttemptRef.current=null;setEditor(null); setPromotionSource(null); setError(""); } }}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); const target = openerRef.current; if (target?.isConnected) target.focus(); else document.getElementById("add-item")?.focus(); }} className="editor-dialog" onInteractOutside={e => e.preventDefault()}>{editor && <ItemEditor key={editor.id} item={editor} selected={selected} busy={busy||linkBusy} error={error} existing={data.items.some(i => i.id === editor.id)} onCancel={() => {promotionAttemptRef.current=null;setEditor(null);setPromotionSource(null);setError("");}} onDelete={() => remove(editor)} onSave={saveEditor}/>}</DialogContent></Dialog>
  </div>;
}

function ItemEditor({ item, selected, busy, error, existing, onCancel, onDelete, onSave }: { item: Item; selected:string; busy:boolean; error:string; existing:boolean; onCancel:()=>void; onDelete:()=>void; onSave:(item:Item)=>Promise<void> }) {
  const [draft,setDraft] = useState(item);
  const [validation,setValidation] = useState("");
  const chooseKind = (kind: Item["kind"]) => setDraft({...draft,kind,date:kind === "note" ? null : draft.date || selected,time:kind === "plan" ? draft.time || "09:00" : null,endTime:kind === "plan" ? draft.endTime : null,done:kind === "note" ? false : draft.done});
  return <><DialogTitle>{existing ? "Edit your" : "Add a"} {draft.kind === "note" ? "capture" : draft.kind}</DialogTitle><DialogDescription>{draft.kind === "priority" ? "Something worth making time for." : draft.kind === "plan" ? "Give this part of your day a time." : "Keep it here until you’re ready to act."}</DialogDescription><form className="editor-form" onSubmit={async e => {e.preventDefault(); const parsed = itemSchema.safeParse(draft); if (!parsed.success) {setValidation(parsed.error.issues[0]?.message || "Check your entries.");return;} setValidation(""); await onSave(parsed.data);}}>
    <fieldset disabled={busy || existing}><legend className="sr-only">Item type</legend><div className="kind-options">{(["priority","plan","note"] as const).map(kind => <button key={kind} type="button" aria-pressed={draft.kind === kind} className={draft.kind === kind ? "chosen" : ""} onClick={() => chooseKind(kind)}>{kind === "note" ? "Capture" : kind === "priority" ? "Priority" : "Plan"}</button>)}</div></fieldset>
    <label htmlFor="item-title">{draft.kind === "note" ? "What’s on your mind?" : "What’s the plan?"}</label><textarea id="item-title" autoFocus required rows={3} maxLength={2000} disabled={busy} value={draft.title} onChange={e => setDraft({...draft,title:e.target.value})} placeholder={draft.kind === "priority" ? "What do you want to move forward?" : draft.kind === "plan" ? "A commitment, appointment, or focus block" : "An idea or something to remember"}/>
    <div className="form-row"><div><label htmlFor="item-area">Life area</label><select id="item-area" value={draft.area} disabled={busy} onChange={e => setDraft({...draft,area:e.target.value as Item["area"]})}><option value="personal">Personal</option><option value="independent">Independent work</option></select></div>{draft.kind !== "note" && <div><label htmlFor="item-date">Date</label><Input type="date" id="item-date" required value={draft.date || ""} disabled={busy} onChange={e => setDraft({...draft,date:e.target.value})}/></div>}</div>
    {draft.kind === "plan" && <div className="form-row"><div><label htmlFor="item-start">Starts</label><Input id="item-start" type="time" required disabled={busy} value={draft.time || ""} onChange={e => setDraft({...draft,time:e.target.value})}/></div><div><label htmlFor="item-end">Ends <span className="optional">(optional)</span></label><Input id="item-end" type="time" disabled={busy} value={draft.endTime || ""} onChange={e => setDraft({...draft,endTime:e.target.value || null})}/></div></div>}
    {(validation || error) && <p className="form-error" role="alert">{validation || error}</p>}
    <div className="editor-actions">{existing && <button type="button" className="delete-button" disabled={busy} onClick={onDelete}><Trash2 size={16}/> Delete</button>}<div><Button variant="ghost" type="button" disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy || !draft.title.trim()}>{busy ? "Saving…" : "Save"}</Button></div></div>
  </form></>;
}
