"use client";

import { LockKeyhole, RefreshCw } from "lucide-react";
import { FinanceConnectionSettings } from "@/components/finance";
import { HealthConnectionSettings } from "@/components/health";
import { IntegrationSettings } from "@/components/integrations";
import { WritingConnectionSettings } from "@/components/writing";

export function SettingsPanel({ active = true }: { active?: boolean }) {
  if (!active) return null;
  return <div className="settings-panel">
    <section className="settings-intro">
      <span><LockKeyhole size={22}/></span>
      <div><h2>One place for every connection.</h2><p>Manage personal accounts, the iPhone bridge, and manual sync here. Credentials remain on this Mac.</p></div>
      <div className="settings-auto"><RefreshCw size={15}/><span>Connected data continues to update automatically while Workspace is open.</span></div>
    </section>
    <section className="settings-section"><IntegrationSettings/></section>
    <section className="settings-section"><FinanceConnectionSettings active={active}/></section>
    <section className="settings-section"><HealthConnectionSettings active={active}/></section>
    <section className="settings-section"><WritingConnectionSettings active={active}/></section>
  </div>;
}
