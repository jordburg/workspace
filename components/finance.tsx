"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, ExternalLink, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { dateKey } from "@/lib/workspace";
import { categoryLabel, emptyFinance, spendingByCurrency, type BankConnection, type FinanceView, type Transaction } from "@/lib/finance";

export const money = (value: number | null, currency: string | null) => {
  if (value === null) return "Unavailable";
  if (!currency) return `${value.toFixed(2)} (currency unavailable)`;
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value); }
  catch { return `${value.toFixed(2)} ${currency}`; }
};

type FinanceResponse = FinanceView & { error: string; linkToken: string };
type PlaidHandler = { open: () => void; destroy: () => void };
type PlaidSDK = { create: (options: { token: string; onSuccess: (token: string) => void; onExit: (error: { display_message?: string } | null) => void }) => PlaidHandler };
declare global { interface Window { Plaid?: PlaidSDK } }

let sdk: Promise<PlaidSDK> | undefined;
async function loadPlaid() {
  if (window.Plaid) return window.Plaid;
  if (!sdk) sdk = new Promise<PlaidSDK>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
    script.onload = () => window.Plaid ? resolve(window.Plaid) : reject(new Error("Plaid did not load."));
    script.onerror = () => { script.remove(); sdk = undefined; reject(new Error("Plaid could not load. Check your connection and try again.")); };
    document.head.appendChild(script);
  });
  return sdk;
}

function useFinance(active = true) {
  const [view, setView] = useState<FinanceView>(emptyFinance);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/finance", { cache: "no-store" });
    const value = await response.json() as FinanceResponse;
    if (!response.ok) throw new Error(value.error);
    setView(value); setLoaded(true); setError("");
    return value;
  }, []);
  const perform = useCallback(async (path: string, body: object = {}) => {
    if (lock.current) throw new Error("Wait for the current request to finish.");
    lock.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/finance${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const next = await response.json() as FinanceResponse;
      if (!response.ok) { await load().catch(() => {}); throw new Error(next.error); }
      if (next.banks) setView(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed.");
      throw cause;
    } finally { lock.current = false; setBusy(false); }
  }, [load]);
  useEffect(() => {
    if (!active) return;
    const initial = setTimeout(() => void load().catch(cause => setError(cause instanceof Error ? cause.message : "Finances could not be loaded.")), 0);
    return () => clearTimeout(initial);
  }, [active, load]);
  useEffect(() => {
    if (!active || !view.banks.length) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !lock.current) void perform("/sync").catch(() => {}); }, 3_600_000);
    return () => clearInterval(timer);
  }, [active, view.banks.length, perform]);
  return { view, loaded, busy, error, perform };
}

export function FinancePanel({ openSettings, selectedDay }: { openSettings: () => void; selectedDay?: string }) {
  const { view, loaded, busy, error, perform } = useFinance();
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState(() => (selectedDay ?? dateKey(new Date())).slice(0, 7));
  const selected = view.banks.flatMap(bank => bank.accounts.filter(account => account.selected).map(account => ({ ...account, bank: bank.name })));
  const totals = spendingByCurrency(view, month);
  const rows = view.transactions.filter(item => item.date.startsWith(month) && `${item.name} ${view.annotations[item.id]?.category || item.category} ${view.annotations[item.id]?.note || ""}`.toLowerCase().includes(query.toLowerCase()));
  const needsAttention = !!error || view.banks.some(bank => !!bank.error);

  return <div className="life-panel">
    {view.environment === "sandbox" && <p className="life-banner">Sandbox mode · Sample bank data only</p>}
    {needsAttention && <div className="settings-link-notice" role="status"><p>Finance data needs attention.</p><Button variant="outline" onClick={openSettings}>Open Settings</Button></div>}
    {!loaded ? <p>Loading finances…</p> : !view.banks.length || !selected.length ? <section className="agenda-panel"><div className="section-heading"><h2>Bank accounts</h2><Button variant="outline" onClick={openSettings}>Open Settings</Button></div><p className="remote-empty">No accounts selected.</p></section> : <>
      <div className="life-metrics">{selected.map(account => <article className="life-metric" key={account.id}><span>{account.bank} · {account.mask ? `••${account.mask}` : account.subtype}</span><strong>{money(account.current, account.currency)}</strong><p>{account.name}{account.type === "credit" ? " · Amount owed" : ""}</p>{account.currency === null && <small>Currency not supplied by bank</small>}</article>)}</div>
      <section className="life-transactions"><div className="life-section-heading"><div><h2>Spending & transactions</h2><p>Posted purchases less refunds; transfers, loan payments, and pending items excluded.</p></div><label>Month<Input type="month" value={month} onChange={event => setMonth(event.target.value)}/></label></div>
        <div className="spending-totals">{Object.entries(totals).map(([currency, amount]) => <span key={currency}>{money(amount, currency)} <small>net spending</small></span>)}{!Object.keys(totals).length && <span>No posted spending for this month</span>}</div>
        <label className="sr-only" htmlFor="transaction-search">Search transactions</label><Input id="transaction-search" placeholder="Search transactions, categories, or notes" value={query} onChange={event => setQuery(event.target.value)}/>
        <div className="transaction-list">{rows.slice(0, 300).map(item => <button className="transaction-row" key={item.id} disabled={busy} onClick={() => setTransaction(item)}><span><strong>{item.name}</strong><small>{item.date} · {view.annotations[item.id]?.category || categoryLabel(item.category)}{item.pending ? " · Pending" : ""}{view.annotations[item.id]?.excludeFromSpending ? " · Excluded from spending" : ""}</small></span><span>{item.amount < 0 ? "+" : "−"}{money(Math.abs(item.amount), item.currency)}</span></button>)}{!rows.length && <p className="life-muted">No matching transactions.</p>}{rows.length > 300 && <p className="life-muted">Showing the first 300 matches. Narrow your search to see more.</p>}</div>
      </section><p className="life-muted">Balances are cached bank values. Categories and notes you edit here stay in this workspace.</p>
    </>}
    <Dialog open={!!transaction} onOpenChange={open => !open && !busy && setTransaction(null)}><DialogContent className="editor-dialog">{transaction && <TransactionEditor key={transaction.id} transaction={transaction} view={view} busy={busy} save={async body => { await perform("/annotate", body); setTransaction(null); }}/>} {error && <p className="form-error" role="alert">{error}</p>}</DialogContent></Dialog>
  </div>;
}

export function FinanceConnectionSettings({ active = true }: { active?: boolean }) {
  const { view, loaded, busy, error, perform } = useFinance(active);
  const [setup, setSetup] = useState(false);
  const [accounts, setAccounts] = useState<BankConnection | null>(null);
  const [plaidError, setPlaidError] = useState("");
  const handler = useRef<PlaidHandler | null>(null);
  useEffect(() => () => handler.current?.destroy(), []);

  async function connect(itemId?: string) {
    try {
      setPlaidError("");
      const plaid = await loadPlaid();
      const { linkToken } = await perform("/link", itemId ? { itemId } : {});
      handler.current?.destroy();
      handler.current = plaid.create({
        token: linkToken,
        onSuccess: token => { void (itemId ? perform("/sync") : perform("/exchange", { publicToken: token })).then(next => { if (!itemId) { const bank = next.banks.find(value => !value.accounts.some(account => account.selected)); if (bank) setAccounts(bank); } }).catch(() => {}); },
        onExit: cause => { if (cause) setPlaidError(cause.display_message || "Bank connection was not completed."); },
      });
      handler.current.open();
    } catch { /* useFinance surfaces the request error */ }
  }

  return <div className="settings-stack">
    <div className="settings-section-heading"><div><h2>Banking</h2><p>Plaid credentials, institutions, and personal account selection.</p></div><div>{view.configured && <Button disabled={busy} onClick={() => void connect()}><Plus size={16}/> Connect a bank</Button>}{view.banks.length > 0 && <Button variant="outline" disabled={busy} onClick={() => void perform("/sync").catch(() => {})}><RefreshCw size={15} className={busy ? "spin" : ""}/> Sync now</Button>}<Button variant="outline" disabled={busy} onClick={() => setSetup(true)}>{view.configured ? "Plaid credentials" : "Set up Plaid"}</Button></div></div>
    {!loaded && <p className="life-muted">Loading banking settings…</p>}
    {view.environment === "sandbox" && <p className="life-banner">Sandbox mode · Sample bank data only</p>}
    {view.banks.length > 0 ? <div className="bank-list">{view.banks.map(bank => <article className="bank-row" key={bank.id}><Building2 size={19}/><div><strong>{bank.name}</strong><p>{bank.lastSynced ? `Last checked ${new Date(bank.lastSynced).toLocaleString()}` : "Choose accounts to begin"} · {bank.accounts.filter(account => account.selected).length} selected</p>{bank.error && <p className="form-error">{bank.error}</p>}{bank.updateStatus === "NOT_READY" && <p>Transactions are still being prepared by the bank.</p>}</div><div className="bank-actions"><button className="text-button" aria-label={`Choose accounts for ${bank.name}`} disabled={busy} onClick={() => setAccounts(bank)}>Choose accounts</button><button className="text-button" aria-label={`Repair connection for ${bank.name}`} disabled={busy} onClick={() => void connect(bank.id)}>Repair connection</button></div></article>)}</div> : loaded && <div className="connection-card"><p className="connection-detail">No bank is connected. Configure Plaid, then open Plaid Link to add Capital One, Bank of America, Rivermark, or another personal institution.</p></div>}
    {(error || plaidError) && <p className="form-error" role="alert">{error || plaidError}</p>}
    <Dialog open={setup} onOpenChange={open => !busy && setSetup(open)}><DialogContent className="editor-dialog connection-dialog"><DialogTitle>Bank connection setup</DialogTitle><DialogDescription>Use your own Plaid developer access to connect your accounts.</DialogDescription><PlaidSetup configured={view.configured} blocked={view.banks.length > 0} busy={busy} save={async body => { await perform("/configure", body); setSetup(false); }}/>{error && <p className="form-error" role="alert">{error}</p>}</DialogContent></Dialog>
    <Dialog open={!!accounts} onOpenChange={open => !open && !busy && setAccounts(null)}><DialogContent className="editor-dialog connection-dialog">{accounts && <AccountPicker bank={accounts} busy={busy} save={async ids => { await perform("/accounts", { itemId: accounts.id, accountIds: ids }); setAccounts(null); }} disconnect={async () => { await perform("/disconnect", { itemId: accounts.id }); setAccounts(null); }}/>} {error && <p className="form-error" role="alert">{error}</p>}</DialogContent></Dialog>
  </div>;
}

function PlaidSetup({ configured, blocked, busy, save }: { configured: boolean; blocked: boolean; busy: boolean; save: (body: object) => Promise<void> }) {
  const [clientId, setClientId] = useState(""); const [secret, setSecret] = useState(""); const [environment, setEnvironment] = useState("production");
  return <form className="editor-form" onSubmit={event => { event.preventDefault(); void save({ clientId, secret, environment }).catch(() => {}); }}><p className="connection-detail">Create a <a href="https://dashboard.plaid.com/signup" target="_blank" rel="noreferrer">Plaid developer account <ExternalLink size={12}/></a>, enable Transactions, and request eligible Production Trial access for real accounts. Trial access has a lifetime limit of 10 bank connections. Verify the plan shown in your Plaid dashboard before linking.</p><p className="connection-detail">Copy your client ID and matching environment secret from Plaid’s API Keys page. Credentials stay on this Mac.</p>{configured && <p className="connection-detail">Plaid is configured.{blocked ? " Disconnect existing banks before changing credentials." : " You can replace your credentials below."}</p>}<fieldset disabled={busy || blocked}><label htmlFor="plaid-client">Plaid client ID</label><Input id="plaid-client" required minLength={10} value={clientId} onChange={event => setClientId(event.target.value)}/><label htmlFor="plaid-secret">Plaid secret</label><Input id="plaid-secret" type="password" required minLength={10} autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)}/><label htmlFor="plaid-environment">Environment</label><select id="plaid-environment" value={environment} onChange={event => setEnvironment(event.target.value)}><option value="production">Production / Trial — real accounts</option><option value="sandbox">Sandbox — sample accounts</option></select><Button className="life-submit" type="submit">Save Plaid connection</Button></fieldset></form>;
}

function AccountPicker({ bank, busy, save, disconnect }: { bank: BankConnection; busy: boolean; save: (ids: string[]) => Promise<void>; disconnect: () => Promise<void> }) {
  const [ids, setIds] = useState(bank.accounts.filter(account => account.selected).map(account => account.id)); const [confirm, setConfirm] = useState(false);
  return <><DialogTitle>{bank.name}</DialogTitle><DialogDescription>Choose only the personal checking, savings, and credit card accounts you want in this workspace.</DialogDescription><div className="account-picker">{bank.accounts.map(account => <label key={account.id}><input type="checkbox" checked={ids.includes(account.id)} disabled={busy || account.blocked || !["depository", "credit"].includes(account.type)} onChange={event => setIds(event.target.checked ? [...ids, account.id] : ids.filter(id => id !== account.id))}/><span>{account.name} {account.mask && `••${account.mask}`}<small>{account.blocked ? "Work or business account excluded" : account.subtype}</small></span></label>)}</div>{!bank.accounts.length && <p>Account details are unavailable. Sync from Settings and try again.</p>}<Button disabled={busy} onClick={() => void save(ids).catch(() => {})}>Save selected accounts</Button><button className="text-button" disabled={busy} onClick={() => setConfirm(!confirm)}>Disconnect this bank</button>{confirm && <div className="delete-confirm"><p>Revoke this Plaid bank connection and remove its cached data and notes from this Mac?</p><Button variant="destructive" disabled={busy} onClick={() => void disconnect().catch(() => {})}>Disconnect bank</Button></div>}</>;
}

function TransactionEditor({ transaction: item, view, busy, save }: { transaction: Transaction; view: FinanceView; busy: boolean; save: (body: object) => Promise<void> }) {
  const [original] = useState(() => view.annotations[item.id]); const [category, setCategory] = useState(original?.category || ""); const [note, setNote] = useState(original?.note || ""); const [exclude, setExclude] = useState(original?.excludeFromSpending || false);
  return <><DialogTitle>{item.name}</DialogTitle><DialogDescription>{item.date} · {money(item.amount, item.currency)}{item.pending ? " · Pending" : ""}</DialogDescription><form className="editor-form" onSubmit={event => { event.preventDefault(); void save({ transactionId: item.id, category, note, excludeFromSpending: exclude, revision: original?.revision || 0 }).catch(() => {}); }}><label htmlFor="transaction-category">Your category</label><Input id="transaction-category" maxLength={80} disabled={busy} placeholder={categoryLabel(item.category)} value={category} onChange={event => setCategory(event.target.value)}/><label htmlFor="transaction-note">Notes</label><textarea id="transaction-note" maxLength={2000} disabled={busy} value={note} onChange={event => setNote(event.target.value)}/><label className="all-day-control"><input type="checkbox" disabled={busy} checked={exclude} onChange={event => setExclude(event.target.checked)}/> Exclude from spending totals</label><p className="connection-detail">These edits are saved in your workspace. The bank’s transaction remains unchanged.</p><Button className="life-submit" type="submit" disabled={busy}>Save transaction notes</Button></form></>;
}
