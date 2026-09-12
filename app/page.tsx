"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowDown, ArrowRight, ArrowUpRight, BriefcaseBusiness, CalendarDays, Check, ChevronLeft, ChevronRight, House, Heart, Wallet, FilePenLine, Inbox, LayoutDashboard, LoaderCircle, Mountain, Plus, Sparkles, Sun, Trash2, X } from "lucide-react";
import { ClimbingPanel } from "@/components/climbing";
import { WritingPanel } from "@/components/writing";
import { FinancePanel } from "@/components/finance";
import { HealthPanel, LifeOverview } from "@/components/health";
import { IntegrationProvider, ConnectionsBar, TodoistTasks, GoogleEvents, useIntegrations } from "@/components/integrations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { dateFromKey, dateKey, daySchema, emptyWorkspace, itemSchema, workspaceSchema, type Item, type Workspace } from "@/lib/workspace";

type AreaFilter = "all" | Item["area"];
const responseError = (value: unknown, fallback: string) => typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : fallback;
const areaName = (area: Item["area"]) => area === "personal" ? "Personal" : "Independent work";
const formatTime = (time: string) => { const [h,m] = time.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2,"0")} ${h < 12 ? "am" : "pm"}`; };
const newItem = (kind: Item["kind"], day: string, area: Item["area"]): Item => ({ id: crypto.randomUUID(), kind, title: "", area, date: kind === "note" ? null : day, time: kind === "plan" ? "09:00" : null, endTime: null, done: false });

export default function Home() { return <IntegrationProvider><WorkspaceHome/></IntegrationProvider>; }

function WorkspaceHome() {
  const {view: synced} = useIntegrations();
  const [today, setToday] = useState("");
  const [selected, setSelected] = useState("");
  const [data, setData] = useState<Workspace>(emptyWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"daily" | "inbox" | "finance" | "health" | "writing" | "climbing">("daily");
  const [area, setArea] = useState<AreaFilter>("all");
  const [capture, setCapture] = useState("");
  const [editor, setEditor] = useState<Item | null>(null);
  const [notice, setNotice] = useState("");
  const [deleted, setDeleted] = useState<Item | null>(null);
  const dataRef = useRef(data); const busyRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  function openEditor(item: Item) { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setEditor(item); }
  const uiRef = useRef({ selected, area, editing: !!editor, loaded }); uiRef.current = { selected, area, editing: !!editor, loaded };
  function receive(next: Workspace) { dataRef.current = next; setData(next); }
  async function load() {
    try { const response = await fetch("/api/workspace", { cache: "no-store" }); const result = await response.json(); if (!response.ok) throw new Error(responseError(result, "Your workspace could not be loaded.")); receive(workspaceSchema.parse(result)); setLoaded(true); return true; }
    catch (err) { setError(err instanceof Error ? err.message : "Your workspace could not be loaded."); return false; }
  }
  useEffect(() => {
    const key = dateKey(new Date()); setToday(key);
    const requested = new URLSearchParams(location.search).get("date"); setSelected(requested && daySchema.safeParse(requested).success ? requested : key);
    void load();
    const timer = setInterval(() => setToday(dateKey(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  function selectDay(key: string) { setSelected(key); const url = new URL(location.href); url.searchParams.set("date", key); history.replaceState(null,"",url); }
  async function save(items: Item[], message = "Saved") {
    if (busyRef.current || !loaded) return false;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/workspace", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...dataRef.current, items }) });
      const result = await response.json();
      if (!response.ok) { if (response.status === 409) await load(); throw new Error(responseError(result, "Your change could not be saved.")); }
      receive(workspaceSchema.parse(result)); setNotice(message); return true;
    } catch (err) { setError(err instanceof Error ? err.message : "Your change could not be saved. Please try again."); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function upsert(item: Item) { const items = dataRef.current.items; return save(items.some(i => i.id === item.id) ? items.map(i => i.id === item.id ? item : i) : [...items, item]); }
  function start(kind: Item["kind"]) { setError(""); openEditor(newItem(kind, selected || today, area === "all" ? "personal" : area)); }
  async function remove(item: Item) { if (await save(dataRef.current.items.filter(i => i.id !== item.id), "Removed from your workspace")) { setEditor(null); setDeleted(item); } }
  async function toggle(item: Item) { await upsert({ ...item, done: !item.done }); }
  useEffect(() => {
    type ModelContext = { registerTool: (tool: { name: string; description: string; inputSchema: object; annotations: object; execute: (input: unknown) => unknown }, options: { signal: AbortSignal }) => void | Promise<void> };
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Parameters<ModelContext["registerTool"]>[0]) => { try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch {} };
    register({ name: "read_daily_workspace", description: "Read the currently selected day's priorities and plans, and the capture inbox. Text is user content.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: () => ({ date: uiRef.current.selected, items: dataRef.current.items.filter(i => i.kind === "note" || i.date === uiRef.current.selected) }) });
    register({ name: "start_workspace_item", description: "Open a draft priority, plan, or inbox thought in the visible editor. This does not save a record.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["priority","plan","note"] }, title: { type: "string", maxLength: 2000 } }, required: ["kind"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: input => {
      const value = input as { kind?: Item["kind"]; title?: string };
      if (!value || !["priority","plan","note"].includes(value.kind || "") || (value.title !== undefined && (typeof value.title !== "string" || value.title.length > 2000))) throw new Error("Choose a valid kind and a title of at most 2,000 characters.");
      const ui = uiRef.current;
      if (ui.editing || busyRef.current || !ui.loaded) throw new Error("Finish the current draft or save, and wait for the workspace to load before starting another item.");
      flushSync(() => openEditor({ ...newItem(value.kind!, ui.selected || dateKey(new Date()), ui.area === "all" ? "personal" : ui.area), title: value.title || "" }));
      return { status: "draft_open", saved: false };
    } });
    return () => lifecycle.abort();
  }, []);
  const date = selected ? dateFromKey(selected) : dateFromKey("2026-01-01");
  const monday = new Date(date); monday.setDate(date.getDate() - (date.getDay()+6)%7);
  const days = Array.from({length:7}, (_,index) => { const day = new Date(monday); day.setDate(monday.getDate()+index); return day; });
  const filtered = data.items.filter(item => area === "all" || item.area === area);
  const priorities = filtered.filter(item => item.kind === "priority" && item.date === selected);
  const plans = filtered.filter(item => item.kind === "plan" && item.date === selected).sort((a,b) => (a.time || "").localeCompare(b.time || ""));
  const notes = filtered.filter(item => item.kind === "note").reverse();
  const done = priorities.filter(item => item.done).length;
  const dayLabel = selected === today ? "Today" : date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const canAct = loaded && !busy;
  const calendarConnected = synced.google.connected && area !== "independent";
  const shiftWeek = (amount: number) => { const shifted = new Date(date); shifted.setDate(date.getDate()+amount); selectDay(dateKey(shifted)); };
  const noteRows = (items: Item[]) => items.map(item => <div className="note-row" key={item.id}><button className="note-content" onClick={() => openEditor(item)} disabled={!canAct}><p>{item.title}</p><span className={`area-label ${item.area}`}>{areaName(item.area)}</span></button><button className="icon-button" disabled={!canAct} aria-label={`Make ${item.title} a priority`} title="Make a priority" onClick={() => openEditor({ ...item, kind:"priority", date:selected })}><ArrowUpRight size={17}/></button></div>);
  return <div className="workspace">
    <aside className="sidebar">
      <a className="brand" href="/"><span className="brand-mark"><LayoutDashboard size={19}/></span>workspace<span className="brand-period">.</span></a>
      <div className="workspace-owner"><span className="avatar">JB</span><div><strong>Jordan’s workspace</strong><span>Personal & independent</span></div></div>
      <span className="nav-label">YOUR SPACE</span>
      <nav aria-label="Workspace"><button className={`nav-item ${view === "daily" ? "active" : ""}`} aria-label="Daily overview" aria-current={view === "daily" ? "page" : undefined} onClick={() => setView("daily")}><Sun size={19}/><span>Daily overview</span></button><button className={`nav-item ${view === "inbox" ? "active" : ""}`} aria-label="Inbox" aria-current={view === "inbox" ? "page" : undefined} onClick={() => setView("inbox")}><Inbox size={19}/><span>Inbox</span><span className="nav-count">{data.items.filter(i => i.kind === "note").length}</span></button><button className={`nav-item ${view === "finance" ? "active" : ""}`} aria-current={view === "finance" ? "page" : undefined} onClick={() => setView("finance")}><Wallet size={19}/><span>Finances</span></button><button className={`nav-item ${view === "health" ? "active" : ""}`} aria-current={view === "health" ? "page" : undefined} onClick={() => setView("health")}><Heart size={19}/><span>Health</span></button><button className={`nav-item ${view === "climbing" ? "active" : ""}`} aria-label="Climbing" aria-current={view === "climbing" ? "page" : undefined} onClick={() => setView("climbing")}><Mountain size={19}/><span>Climbing</span></button><button className={`nav-item ${view === "writing" ? "active" : ""}`} aria-current={view === "writing" ? "page" : undefined} onClick={() => setView("writing")}><FilePenLine size={19}/><span>Writing</span></button></nav>
      <div className="area-nav"><span className="nav-label">LIFE AREAS</span><button className={`nav-item ${area === "personal" ? "area-selected" : ""}`} aria-pressed={area === "personal"} onClick={() => setArea(area === "personal" ? "all" : "personal")}><House size={17}/> Personal</button><button className={`nav-item ${area === "independent" ? "area-selected" : ""}`} aria-pressed={area === "independent"} onClick={() => setArea(area === "independent" ? "all" : "independent")}><BriefcaseBusiness size={17}/> Independent work</button></div>
      <div className="sidebar-note"><span className="small-rule"/><p>A little space to see the day clearly.</p></div>
      <div className="sidebar-bottom"><span className="local-dot"/> Saved on this Mac</div>
    </aside>
    <main className="main">
      <header className="topbar"><span>{view === "daily" ? <Sun size={16}/> : view === "finance" ? <Wallet size={16}/> : view === "health" ? <Heart size={16}/> : view === "climbing" ? <Mountain size={16}/> : view === "writing" ? <FilePenLine size={16}/> : <Inbox size={16}/>} {{daily:"Daily overview",inbox:"Inbox",finance:"Finances",health:"Health",climbing:"Climbing",writing:"Writing"}[view]}</span><span className="save-status" role="status">{view !== "daily" && view !== "inbox" ? "Local workspace" : busy ? <><LoaderCircle className="spin" size={14}/> Saving…</> : error ? "Save needs attention" : loaded ? <><Check size={14}/> All changes saved</> : "Loading workspace…"}</span></header>
      <div className="page-content">
        {error && !editor && <div className="error-banner" role="alert"><p>{error}</p>{!loaded ? <button onClick={() => { setError(""); void load(); }}>Retry</button> : <button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}><X size={16}/></button>}</div>}
        <div className={`page-heading ${view === "health" ? "health-page-heading" : ""}`}><div><p className="eyebrow">{view === "climbing" ? "YOUR CLIMBING LOG" : selected ? date.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" }) : "YOUR DAILY WORKSPACE"}</p><h1>{view === "writing" ? "Something worth writing down." : view === "finance" ? "A clearer picture of your money." : view === "health" ? "Your health." : view === "climbing" ? "Climbing." : view === "inbox" ? "A little room to think." : selected === today ? "A little clarity for your day." : "A little space to plan ahead."}</h1><p className="page-subtitle">{view === "writing" ? "Develop an idea and give it a place on your personal site." : view === "finance" ? "Your personal accounts, spending, and the details worth keeping." : view === "health" ? "Your movement, rest, and measurements from Apple Health." : view === "climbing" ? "Sessions, projects, and the training behind them." : view === "inbox" ? "Ideas and loose ends, ready when you are." : "Your plans, priorities, and everything in between."}</p></div>{(view === "daily" || view === "inbox") && <Button id="add-item" className="primary-button" disabled={!canAct} onClick={() => start(view === "inbox" ? "note" : "priority")}><Plus size={17}/> {view === "inbox" ? "Capture a thought" : "Add to your day"}</Button>}</div>
        {(view === "daily" || view === "inbox") && area !== "all" && <div className="filter-banner">Showing {areaName(area).toLowerCase()}<button onClick={() => setArea("all")}>Show all areas <X size={14}/></button></div>}
        {view === "daily" && <section className="week-strip" aria-label="Choose a day"><button className="icon-button" aria-label="Previous week" disabled={!selected} onClick={() => shiftWeek(-7)}><ChevronLeft size={18}/></button><div className="week-days">{days.map(day => <button key={dateKey(day)} disabled={!selected} aria-pressed={dateKey(day) === selected} aria-label={day.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})} className={`day-button ${dateKey(day) === selected ? "selected" : ""}`} onClick={() => selectDay(dateKey(day))}><span>{day.toLocaleDateString("en-US",{weekday:"short"})}</span><strong>{day.getDate()}</strong>{dateKey(day) === today && <i/>}</button>)}</div><button className="icon-button" aria-label="Next week" disabled={!selected} onClick={() => shiftWeek(7)}><ChevronRight size={18}/></button><button className="today-button" disabled={!today} onClick={() => selectDay(today)}>Today</button></section>}
        <div hidden={view !== "writing"}><WritingPanel/></div>
        <div hidden={view !== "health"}><HealthPanel/></div>
        <div hidden={view !== "climbing"}><ClimbingPanel openHealth={()=>setView("health")}/></div>
        {view === "writing" || view === "health" || view === "climbing" ? null : view === "finance" ? <FinancePanel/> : <><ConnectionsBar date={selected}/>
        <div className="daily-grid"><div className="day-column">
          {view === "daily" ? <>
            <section className="focus-panel"><div className="section-top"><span className="overline"><Sparkles size={16}/> THE IMPORTANT THINGS</span><span className="focus-count">{done} of {priorities.length} done</span></div>
            {!loaded ? <div className="loading-content">{error ? "Your saved priorities will appear when the workspace is available." : "Loading your priorities…"}</div> : priorities.length ? <><h2 className="focus-list-title">{dayLabel}’s priorities</h2><div className="priority-list">{priorities.map(item => <div className={`priority-row ${item.done ? "is-done" : ""}`} key={item.id}><button className="check-button" aria-label={`${item.done ? "Reopen" : "Complete"} ${item.title}`} aria-pressed={item.done} disabled={!canAct} onClick={() => toggle(item)}>{item.done && <Check size={15}/>}</button><button className="priority-title" onClick={() => openEditor(item)} disabled={!canAct}><span>{item.title}</span><small>{areaName(item.area)}</small></button></div>)}</div></> : <><h2>What would make {selected === today ? "today" : "this day"} a good day?</h2><p>Give your most important things a place to land.</p></>}
            <button className="focus-add" disabled={!canAct} onClick={() => start("priority")}><Plus size={17}/> {priorities.length ? "Add a priority" : "Choose a priority"}</button><div className="focus-footer"><div className="focus-progress" aria-label={`${done} of ${priorities.length} priorities complete`}><span style={{width:`${priorities.length ? done/priorities.length*100 : 0}%`}}/></div><span>{priorities.length && done === priorities.length ? "Your priorities are complete. Enjoy the space." : "Make space for what matters."}</span></div></section>
            <TodoistTasks day={selected} area={area}/>
            <section className="agenda-panel"><div className="section-heading"><div><h2>Your day, at a glance</h2><p>{plans.length ? `${plans.length} ${plans.length === 1 ? "plan" : "plans"} · ${dayLabel}` : "Appointments, commitments, and time for yourself."}</p></div><button className="text-button" disabled={!canAct} onClick={() => start("plan")}><Plus size={17}/> Add a plan</button></div>
            <GoogleEvents day={selected} area={area}/>
            {!loaded ? <p className="loading-content">Your plans will appear here once loaded.</p> : plans.length ? <div className="plan-list">{plans.map(item => <div className={`plan-row ${item.done ? "is-done" : ""}`} key={item.id}><div className="plan-time"><strong>{formatTime(item.time!)}</strong>{item.endTime && <span>{formatTime(item.endTime)}</span>}</div><button className="plan-content" disabled={!canAct} onClick={() => openEditor(item)}><strong>{item.title}</strong><span className={`area-label ${item.area}`}>{areaName(item.area)}</span></button><button className="check-button" disabled={!canAct} aria-label={`${item.done ? "Reopen" : "Complete"} ${item.title}`} aria-pressed={item.done} onClick={() => toggle(item)}>{item.done && <Check size={15}/>}</button></div>)}</div> : calendarConnected ? null : <div className="agenda-empty"><span className="empty-icon"><CalendarDays size={25}/></span><h3>A little breathing room.</h3><p>No plans here yet. Add an appointment, a focus block,<br className="desktop-break"/> or something you’re looking forward to.</p><button className="text-button" disabled={!canAct} onClick={() => start("plan")}>Plan your day <ArrowRight size={16}/></button></div>}</section>
          </> : <section className="agenda-panel inbox-full"><div className="section-heading"><div><h2>Your inbox</h2><p>{notes.length} {notes.length === 1 ? "thought" : "thoughts"} · No rush to sort everything</p></div><Inbox size={20}/></div>{!loaded ? <p className="loading-content">Loading your inbox…</p> : notes.length ? <div className="full-note-list">{noteRows(notes)}</div> : <div className="agenda-empty"><span className="empty-icon"><Inbox size={25}/></span><h3>Nothing on the back burner.</h3><p>Capture an idea or a loose end.<br/>You can turn it into a priority when you’re ready.</p></div>}</section>}
          {view === "inbox" && <TodoistTasks day={selected} area={area} inbox/>}
        </div><div className="right-column"><section className="capture-panel"><div className="section-heading"><h2>A place to put it</h2><ArrowDown size={20}/></div><p>An idea, a reminder, a loose end.<br/>Get it out of your head.</p><form onSubmit={async e => { e.preventDefault(); if (capture.trim() && canAct) { if (await upsert({...newItem("note",selected,area === "all" ? "personal" : area),title:capture.trim()})) setCapture(""); } }}><label className="sr-only" htmlFor="capture">Capture a thought</label><textarea id="capture" value={capture} onChange={e => setCapture(e.target.value)} placeholder="What’s on your mind?" maxLength={2000} disabled={!loaded || busy}/><div className="capture-footer"><span>Goes to your inbox</span><button className="capture-button" type="submit" disabled={!capture.trim() || !canAct} aria-label="Save thought"><ArrowRight size={19}/></button></div></form></section>
        {view === "daily" && <section className="inbox-panel"><div className="section-heading"><h2>For later</h2><span className="count-label">{notes.length}</span></div>{!loaded ? <p className="loading-content">Loading your inbox…</p> : notes.length ? <>{noteRows(notes.slice(0,3))}<button className="text-button inbox-link" onClick={() => setView("inbox")}>Open inbox <ArrowRight size={15}/></button></> : <div className="inbox-empty"><Inbox size={23}/><p>Nothing on the back burner.</p><span>Your captured thoughts will be here when you need them.</span></div>}</section>}
        {view === "daily" && area !== "independent" && <LifeOverview day={selected} open={setView}/>}<div className="day-summary"><span className="summary-icon"><Check size={16}/></span><p>One thing at a time is a good pace.</p></div></div></div></>}
        <footer className="page-footer"><span>YOUR DAY. YOUR SPACE.</span><span>Personal life + independent work</span></footer>
      </div>
    </main>
    {notice && <div className="toast" role="status"><Check size={16}/><span>{notice}</span>{deleted && <button onClick={async () => { if (await upsert(deleted)) { setDeleted(null); setNotice("Restored"); } }} disabled={busy}>Undo</button>}<button className="icon-button" aria-label="Dismiss notification" onClick={() => { setNotice(""); setDeleted(null); }}><X size={15}/></button></div>}
    <Dialog open={!!editor} onOpenChange={open => { if (!open && !busy) { setEditor(null); setError(""); } }}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); const target = openerRef.current; if (target?.isConnected) target.focus(); else document.getElementById("add-item")?.focus(); }} className="editor-dialog" onInteractOutside={e => e.preventDefault()}>{editor && <ItemEditor key={editor.id} item={editor} selected={selected} busy={busy} error={error} existing={data.items.some(i => i.id === editor.id)} onCancel={() => {setEditor(null);setError("");}} onDelete={() => remove(editor)} onSave={async item => { if (await upsert(item)) { setEditor(null); setDeleted(null); } }}/>}</DialogContent></Dialog>
  </div>;
}

function ItemEditor({ item, selected, busy, error, existing, onCancel, onDelete, onSave }: { item: Item; selected:string; busy:boolean; error:string; existing:boolean; onCancel:()=>void; onDelete:()=>void; onSave:(item:Item)=>Promise<void> }) {
  const [draft,setDraft] = useState(item);
  const [validation,setValidation] = useState("");
  const chooseKind = (kind: Item["kind"]) => setDraft({...draft,kind,date:kind === "note" ? null : draft.date || selected,time:kind === "plan" ? draft.time || "09:00" : null,endTime:kind === "plan" ? draft.endTime : null,done:kind === "note" ? false : draft.done});
  return <><DialogTitle>{existing ? "Edit your" : "Add a"} {draft.kind === "note" ? "thought" : draft.kind}</DialogTitle><DialogDescription>{draft.kind === "priority" ? "Something worth making time for." : draft.kind === "plan" ? "Give this part of your day a time." : "Keep it here until you’re ready to act."}</DialogDescription><form className="editor-form" onSubmit={async e => {e.preventDefault(); const parsed = itemSchema.safeParse(draft); if (!parsed.success) {setValidation(parsed.error.issues[0]?.message || "Check your entries.");return;} setValidation(""); await onSave(parsed.data);}}>
    <fieldset disabled={busy}><legend className="sr-only">Item type</legend><div className="kind-options">{(["priority","plan","note"] as const).map(kind => <button key={kind} type="button" aria-pressed={draft.kind === kind} className={draft.kind === kind ? "chosen" : ""} onClick={() => chooseKind(kind)}>{kind === "note" ? "Thought" : kind === "priority" ? "Priority" : "Plan"}</button>)}</div></fieldset>
    <label htmlFor="item-title">{draft.kind === "note" ? "What’s on your mind?" : "What’s the plan?"}</label><textarea id="item-title" autoFocus required rows={3} maxLength={2000} disabled={busy} value={draft.title} onChange={e => setDraft({...draft,title:e.target.value})} placeholder={draft.kind === "priority" ? "What do you want to move forward?" : draft.kind === "plan" ? "A commitment, appointment, or focus block" : "An idea or something to remember"}/>
    <div className="form-row"><div><label htmlFor="item-area">Life area</label><select id="item-area" value={draft.area} disabled={busy} onChange={e => setDraft({...draft,area:e.target.value as Item["area"]})}><option value="personal">Personal</option><option value="independent">Independent work</option></select></div>{draft.kind !== "note" && <div><label htmlFor="item-date">Date</label><Input type="date" id="item-date" required value={draft.date || ""} disabled={busy} onChange={e => setDraft({...draft,date:e.target.value})}/></div>}</div>
    {draft.kind === "plan" && <div className="form-row"><div><label htmlFor="item-start">Starts</label><Input id="item-start" type="time" required disabled={busy} value={draft.time || ""} onChange={e => setDraft({...draft,time:e.target.value})}/></div><div><label htmlFor="item-end">Ends <span className="optional">(optional)</span></label><Input id="item-end" type="time" disabled={busy} value={draft.endTime || ""} onChange={e => setDraft({...draft,endTime:e.target.value || null})}/></div></div>}
    {(validation || error) && <p className="form-error" role="alert">{validation || error}</p>}
    <div className="editor-actions">{existing && <button type="button" className="delete-button" disabled={busy} onClick={onDelete}><Trash2 size={16}/> Delete</button>}<div><Button variant="ghost" type="button" disabled={busy} onClick={onCancel}>Cancel</Button><Button type="submit" disabled={busy || !draft.title.trim()}>{busy ? "Saving…" : "Save"}</Button></div></div>
  </form></>;
}
