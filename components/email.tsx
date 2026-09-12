"use client";

import { useRef, useState } from "react";
import { Archive, CalendarPlus, ExternalLink, Inbox, ListTodo, Mail, MailOpen, PenLine, RefreshCw, Reply, Send, Star, Trash2 } from "lucide-react";
import { useIntegrations } from "@/components/integrations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { dateKey } from "@/lib/workspace";
import type { RemoteMail } from "@/lib/integrations/model";

type MailDraft = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Gmail could not apply this change.";
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const recipients = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);
const replySubject = (subject: string) => /^re:/i.test(subject.trim()) ? subject : `Re: ${subject || "(no subject)"}`;
const syncRequest = (date: string) => ({ date: date || dateKey(new Date()), timeZone: timeZone() });
const messageTime = (value: string) => {
  const received = new Date(value);
  if (!Number.isFinite(received.getTime())) return "";
  const now = new Date();
  return received.toDateString() === now.toDateString()
    ? received.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : received.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(received.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
};
export function TodayMailCard({ openMail }: { openMail: () => void }) {
  const { view, busy, openSettings } = useIntegrations();
  const messages = view.messages.filter(message => message.unread).slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 3);

  return <section className="today-mail-card" aria-labelledby="today-mail-heading">
    <div className="section-heading">
      <div><h2 id="today-mail-heading">Mail</h2><p>{view.gmail.connected ? `${view.gmail.unreadCount} unread in the recent personal inbox` : "Personal Gmail"}</p></div>
      <span className="mail-card-icon"><Mail size={18}/></span>
    </div>
    {!view.gmail.connected ? <div className="today-mail-empty"><p>Bring the messages that need a decision into your daily view.</p><button className="text-button" onClick={openSettings}>Connect Gmail</button></div>
      : messages.length ? <div className="today-mail-list">{messages.map(message => <a href={message.url} target="_blank" rel="noreferrer" key={message.id}><span className="unread-dot"/><span><strong>{message.subject || "(no subject)"}</strong><small>{message.from} · {messageTime(message.receivedAt)}</small></span><ExternalLink size={13}/></a>)}</div>
      : <div className="today-mail-empty"><MailOpen size={20}/><p>No unread mail needs your attention.</p></div>}
    {view.gmail.connected && <button className="text-button today-mail-open" disabled={busy} onClick={openMail}>Open mail</button>}
  </section>;
}

export function MailPanel() {
  const { view, busy, error, date, perform, openSettings } = useIntegrations();
  const [filter, setFilter] = useState<"unread" | "all">("unread");
  const [composer, setComposer] = useState<{ key: string; reply?: RemoteMail } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const mutationRequests = useRef(new Map<string, string>());
  const messages = (filter === "unread" ? view.messages.filter(message => message.unread) : view.messages)
    .slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

  function openComposer(reply?: RemoteMail) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setComposer({ key: crypto.randomUUID(), reply });
  }

  async function mutate(message: RemoteMail, action: "read" | "unread" | "star" | "unstar" | "archive" | "trash") {
    const key = JSON.stringify([message.id, message.version, action]);
    const requestId = mutationRequests.current.get(key) || crypto.randomUUID();
    mutationRequests.current.set(key, requestId);
    await perform("/gmail/mutate", { id: message.id, version: message.version, action, requestId, ...(action === "trash" ? { confirm: true } : {}) });
    mutationRequests.current.delete(key);
  }

  if (!view.gmail.connected) return <section className="mail-connect-panel"><span><Mail size={28}/></span><p className="eyebrow">PERSONAL GMAIL</p><h2>Bring your inbox into the same calm space.</h2><p>See what needs attention, reply or compose when you choose, and clear messages by archiving or moving them to Gmail Trash.</p><Button onClick={openSettings}>Set up Gmail</Button></section>;

  return <section className="mail-panel" aria-labelledby="mail-panel-heading">
    <div className="mail-toolbar">
      <div><h2 id="mail-panel-heading">Personal inbox</h2><p>{view.gmail.account || "Personal Gmail"}{view.gmail.lastSynced ? ` · Updated ${new Date(view.gmail.lastSynced).toLocaleString()}` : " · Ready to sync"}</p></div>
      <div className="mail-toolbar-actions"><button className="mail-quiet-button" disabled={busy} onClick={() => void perform("/gmail/sync", syncRequest(date)).catch(() => {})}><RefreshCw className={busy ? "spin" : ""} size={15}/> Refresh</button><Button disabled={busy} onClick={() => openComposer()}><PenLine size={16}/> Compose</Button></div>
    </div>
    <div className="mail-filter-row">
      <div className="mail-filters" aria-label="Filter mail"><button aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>Unread <span>{view.gmail.unreadCount}</span></button><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All <span>{view.messages.length}</span></button></div>
      <p>Messages stay in Gmail. Workspace keeps only the recent view it needs.</p>
    </div>
    {(error || view.gmail.error) && <div className="mail-error" role="alert">{error || view.gmail.error}</div>}
    {messages.length ? <div className="mail-list">{messages.map(message => <MailRow key={message.id} message={message} busy={busy} mutate={mutate} reply={() => openComposer(message)}/>)}</div>
      : <div className="mail-empty"><span><Inbox size={26}/></span><h3>{filter === "unread" ? "You’re caught up." : "No recent messages to show."}</h3><p>{filter === "unread" ? "There’s no unread mail in this recent view." : "Refresh Gmail to check for recent messages."}</p></div>}
    <Dialog open={!!composer} onOpenChange={open => { if (!open && !busy) setComposer(null); }}><DialogContent className="editor-dialog mail-compose-dialog" onInteractOutside={event => event.preventDefault()} onCloseAutoFocus={event => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}>{composer && <MailComposer key={composer.key} reply={composer.reply} onClose={() => setComposer(null)}/>}</DialogContent></Dialog>
  </section>;
}

function MailRow({ message, busy, mutate, reply }: { message: RemoteMail; busy: boolean; mutate: (message: RemoteMail, action: "read" | "unread" | "star" | "unstar" | "archive" | "trash") => Promise<void>; reply: () => void }) {
  const { view, date, openEditor } = useIntegrations();
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [rowError, setRowError] = useState("");
  const act = async (action: "read" | "unread" | "star" | "unstar" | "archive" | "trash") => { setRowError(""); try { await mutate(message, action); } catch (error) { setRowError(errorMessage(error)); } };
  return <article className={`mail-row ${message.unread ? "is-unread" : ""}`}>
    <div className="mail-row-status"><button className={`mail-star ${message.starred ? "is-starred" : ""}`} disabled={busy} aria-label={`${message.starred ? "Remove star from" : "Star"} ${message.subject || "message"}`} aria-pressed={message.starred} onClick={() => void act(message.starred ? "unstar" : "star")}><Star size={17} fill={message.starred ? "currentColor" : "none"}/></button>{message.unread && <span className="unread-dot" aria-label="Unread"/>}</div>
    <div className="mail-copy"><div className="mail-sender-line"><strong>{message.from}</strong><time dateTime={message.receivedAt}>{messageTime(message.receivedAt)}</time></div><a href={message.url} target="_blank" rel="noreferrer" className="mail-subject">{message.subject || "(no subject)"} <ExternalLink size={12}/></a>{message.snippet && <p>{message.snippet}</p>}<div className="mail-row-actions"><button disabled={busy || !message.replyTo} title={message.replyTo ? undefined : "Open this message in Gmail to reply"} onClick={reply}><Reply size={14}/> Reply</button><button disabled={busy} onClick={() => void act(message.unread ? "read" : "unread")}>{message.unread ? <MailOpen size={14}/> : <Mail size={14}/>} Mark {message.unread ? "read" : "unread"}</button><button disabled={busy} onClick={() => void act("archive")}><Archive size={14}/> Archive</button>{view.todoist.connected && <button disabled={busy} onClick={() => openEditor({ provider: "todoist", day: date || dateKey(new Date()), preset: { title: `Follow up: ${message.subject || "email"}` }, description: "Review this Todoist task, choose its date and Personal project, then save it." })}><ListTodo size={14}/> Add task</button>}{view.google.connected && <button disabled={busy} onClick={() => openEditor({ provider: "google", day: date || dateKey(new Date()), preset: { title: `Email: ${message.subject || "follow-up"}` }, description: "Review the time block below, then save it to your personal Google Calendar." })}><CalendarPlus size={14}/> Block time</button>}<button className="mail-trash-button" disabled={busy} onClick={() => setConfirmTrash(true)}><Trash2 size={14}/> Trash</button></div>{message.important && <span className="mail-important">Important</span>}
      {confirmTrash && <div className="mail-trash-confirm" role="alert"><p>Move this message to Gmail Trash? You can recover it from Gmail.</p><div><button disabled={busy} onClick={() => setConfirmTrash(false)}>Cancel</button><Button variant="destructive" size="sm" disabled={busy} onClick={() => void act("trash")}>Move to Trash</Button></div></div>}
      {rowError && <p className="mail-row-error" role="alert">{rowError}</p>}
    </div>
  </article>;
}

function MailComposer({ reply, onClose }: { reply?: RemoteMail; onClose: () => void }) {
  const { busy, perform } = useIntegrations();
  const [draft, setDraft] = useState<MailDraft>({ to: reply?.replyTo || reply?.from || "", cc: "", bcc: "", subject: reply ? replySubject(reply.subject) : "", body: "" });
  const [localError, setLocalError] = useState("");
  const request = useRef({ id: crypto.randomUUID(), payload: "" });
  const update = (next: Partial<MailDraft>) => { request.current = { id: crypto.randomUUID(), payload: "" }; setDraft(current => ({ ...current, ...next })); setLocalError(""); };
  async function sendMessage() {
    const to = recipients(draft.to); const cc = recipients(draft.cc); const bcc = recipients(draft.bcc);
    if (!to.length) { setLocalError("Add at least one recipient before sending."); return; }
    if (!draft.subject.trim()) { setLocalError("Add a subject before sending."); return; }
    if (!draft.body.trim()) { setLocalError("Write a message before sending."); return; }
    const body = { to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject: draft.subject, body: draft.body, ...(reply ? { replyToId: reply.id } : {}), confirm: true };
    const payload = JSON.stringify(body);
    if (request.current.payload && request.current.payload !== payload) request.current = { id: crypto.randomUUID(), payload };
    else request.current.payload = payload;
    setLocalError("");
    try { await perform("/gmail/send", { ...body, requestId: request.current.id }); onClose(); }
    catch (error) { setLocalError(errorMessage(error)); }
  }
  return <><DialogTitle>{reply ? "Reply" : "New message"}</DialogTitle><DialogDescription>{reply ? `Replying to ${reply.from}. Review the message below, then choose Send.` : "Your message will be sent from your personal Gmail account only after you choose Send."}</DialogDescription>
    <form className="mail-compose-form" onSubmit={event => { event.preventDefault(); void sendMessage(); }}>
      <label htmlFor="mail-to">To</label><input id="mail-to" autoFocus={!reply} autoComplete="off" maxLength={2000} required disabled={busy || !!reply} value={draft.to} onChange={event => update({ to: event.target.value })} placeholder="name@example.com"/>
      <div className="mail-recipient-grid"><label htmlFor="mail-cc">Cc <span>(optional)</span><input id="mail-cc" autoComplete="off" maxLength={2000} disabled={busy} value={draft.cc} onChange={event => update({ cc: event.target.value })}/></label><label htmlFor="mail-bcc">Bcc <span>(optional)</span><input id="mail-bcc" autoComplete="off" maxLength={2000} disabled={busy} value={draft.bcc} onChange={event => update({ bcc: event.target.value })}/></label></div>
      <label htmlFor="mail-subject">Subject</label><input id="mail-subject" maxLength={998} required disabled={busy || !!reply} value={draft.subject} onChange={event => update({ subject: event.target.value })}/>
      <label htmlFor="mail-body">Message</label><textarea id="mail-body" autoFocus={!!reply} rows={10} maxLength={50000} required disabled={busy} value={draft.body} onChange={event => update({ body: event.target.value })} placeholder={reply ? "Write your reply…" : "Write your message…"}/>
      {localError && <p className="form-error" role="alert">{localError}</p>}
      <p className="mail-send-note"><Send size={14}/> This sends immediately through Gmail. Workspace does not schedule or send drafts on its own.</p>
      <div className="editor-actions"><div><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !draft.to.trim() || !draft.subject.trim() || !draft.body.trim()}><Send size={15}/>{busy ? "Sending…" : "Send"}</Button></div></div>
    </form>
  </>;
}
