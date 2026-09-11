"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Circle, Inbox, LayoutDashboard, Plus, Sparkles, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export default function Home() {
  const [today, setToday] = useState("");
  const [selected, setSelected] = useState("");
  const [capture, setCapture] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  useEffect(() => { const key = dateKey(new Date()); setToday(key); setSelected(key); }, []);
  const date = selected ? new Date(`${selected}T12:00:00`) : new Date("2026-01-01T12:00:00");
  const monday = new Date(date); monday.setDate(date.getDate() - (date.getDay() + 6) % 7);
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(monday); day.setDate(monday.getDate() + index); return day; });
  return <div className="workspace">
    <aside className="sidebar">
      <a className="brand" href="/"><span className="brand-mark"><LayoutDashboard size={19}/></span>workspace<span className="brand-period">.</span></a>
      <div className="workspace-owner"><span className="avatar">JB</span><div><strong>Jordan’s workspace</strong><span>Personal & independent</span></div></div>
      <span className="nav-label">YOUR SPACE</span>
      <nav><button className="nav-item active"><Sun size={19}/> Daily overview</button><button className="nav-item" onClick={() => document.getElementById("capture")?.focus()}><Inbox size={19}/> Inbox <span className="nav-count">{notes.length}</span></button></nav>
      <div className="sidebar-note"><span className="small-rule"/><p>A little space to see the day clearly.</p></div>
      <div className="sidebar-bottom"><span className="local-dot"/> Local workspace</div>
    </aside>
    <main className="main">
      <header className="topbar"><span><Sun size={16}/> Daily overview</span><span className="topbar-right">Made room for what matters.</span></header>
      <div className="page-content">
        <div className="page-heading"><div><p className="eyebrow">{today ? new Date(`${today}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "YOUR DAILY WORKSPACE"}</p><h1>A little clarity for your day.</h1><p className="page-subtitle">Your plans, priorities, and everything in between.</p></div><Button className="primary-button" onClick={() => document.getElementById("capture")?.focus()}><Plus size={17}/> Add to your day</Button></div>
        <section className="week-strip" aria-label="Choose a day"><button className="icon-button" aria-label="Previous week" onClick={() => { const d = new Date(date); d.setDate(d.getDate()-7); setSelected(dateKey(d)); }}><ChevronLeft size={18}/></button><div className="week-days">{days.map(day => <button key={dateKey(day)} className={`day-button ${dateKey(day) === selected ? "selected" : ""}`} onClick={() => setSelected(dateKey(day))}><span>{day.toLocaleDateString("en-US", { weekday: "short" })}</span><strong>{day.getDate()}</strong>{dateKey(day) === today && <i/>}</button>)}</div><button className="icon-button" aria-label="Next week" onClick={() => { const d = new Date(date); d.setDate(d.getDate()+7); setSelected(dateKey(d)); }}><ChevronRight size={18}/></button><button className="today-button" onClick={() => setSelected(today)}>Today</button></section>
        <div className="daily-grid"><div className="day-column">
          <section className="focus-panel"><div className="section-top"><span className="overline"><Sparkles size={16}/> THE IMPORTANT THINGS</span><span className="focus-count">0 done</span></div><h2>What would make today a good day?</h2><p>Give your most important things a place to land.</p><button className="focus-add" onClick={() => document.getElementById("capture")?.focus()}><Plus size={17}/> Choose a priority</button><div className="focus-footer"><span className="focus-line"/><span>Make space. Find your focus.</span></div></section>
          <section className="agenda-panel"><div className="section-heading"><div><h2>Your day, at a glance</h2><p>Plans with a time and a place.</p></div><button className="text-button" onClick={() => document.getElementById("capture")?.focus()}><Plus size={17}/> Add a plan</button></div><div className="agenda-empty"><span className="empty-icon"><CalendarDays size={25}/></span><h3>A little breathing room.</h3><p>No plans here yet. Add an appointment, a focus block,<br className="desktop-break"/> or something you’re looking forward to.</p><button className="text-button" onClick={() => document.getElementById("capture")?.focus()}>Plan your day <ArrowRight size={16}/></button></div></section>
        </div><div className="right-column"><section className="capture-panel"><div className="section-heading"><h2>A place to put it</h2><ArrowDown size={20}/></div><p>An idea, a reminder, a loose end.<br/>Get it out of your head.</p><form onSubmit={e => { e.preventDefault(); if (capture.trim()) { setNotes([capture.trim(), ...notes]); setCapture(""); } }}><label className="sr-only" htmlFor="capture">Capture a thought</label><textarea id="capture" value={capture} onChange={e => setCapture(e.target.value)} placeholder="What’s on your mind?" maxLength={2000}/><div className="capture-footer"><span>Goes to your inbox</span><button className="capture-button" type="submit" disabled={!capture.trim()} aria-label="Save thought"><ArrowRight size={19}/></button></div></form></section><section className="inbox-panel"><div className="section-heading"><h2>For later</h2><span className="count-label">{notes.length}</span></div>{notes.length ? notes.map((note, i) => <div className="note-row" key={i}><Circle size={15}/><p>{note}</p><button className="icon-button" aria-label={`Remove ${note}`} onClick={() => setNotes(notes.filter((_, index) => index !== i))}><X size={15}/></button></div>) : <div className="inbox-empty"><Inbox size={23}/><p>Nothing on the back burner.</p><span>Your captured thoughts will be here when you need them.</span></div>}</section><div className="day-summary"><span className="summary-icon"><Check size={16}/></span><p>One thing at a time is a good pace.</p></div></div></div>
        <footer className="page-footer"><span>YOUR DAY. YOUR SPACE.</span><span>Personal life + independent work</span></footer>
      </div>
    </main>
  </div>;
}
