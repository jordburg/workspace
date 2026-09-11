import { z } from "zod";
import { daySchema } from "./workspace.ts";

export type BankAccount = { id:string; name:string; mask:string; type:string; subtype:string; currency:string|null; current:number|null; available:number|null; selected:boolean; blocked:boolean };
export type BankConnection = { id:string; name:string; accounts:BankAccount[]; lastSynced:string|null; error:string|null; updateStatus:string|null };
export type Transaction = { id:string; itemId:string; accountId:string; date:string; name:string; amount:number; currency:string|null; pending:boolean; category:string; pendingId:string|null };
export type TransactionNote = { category:string; note:string; excludeFromSpending:boolean; revision:number };
export type FinanceView = { configured:boolean; environment:"production"|"sandbox"|null; banks:BankConnection[]; transactions:Transaction[]; annotations:Record<string,TransactionNote> };
export const emptyFinance=():FinanceView=>({configured:false,environment:null,banks:[],transactions:[],annotations:{}});
export const noteSchema=z.object({transactionId:z.string().min(1).max(300),category:z.string().trim().max(80),note:z.string().trim().max(2000),excludeFromSpending:z.boolean(),revision:z.number().int().nonnegative()}).strict();

const accountSchema=z.object({account_id:z.string(),name:z.string(),official_name:z.string().nullable().optional(),mask:z.string().nullable().optional(),type:z.string(),subtype:z.string().nullable().optional(),balances:z.object({current:z.number().finite().nullable(),available:z.number().finite().nullable(),iso_currency_code:z.string().nullable(),unofficial_currency_code:z.string().nullable().optional()})});
export function normalizeAccount(value:unknown,selected:Set<string>):BankAccount {
  const a=accountSchema.parse(value);const blocked=/artek/i.test(`${a.name} ${a.official_name||""}`)||["business","commercial","commercial line of credit"].includes(a.subtype||"");
  const included=selected.has(a.account_id)&&!blocked;
  return {id:a.account_id,name:a.name,mask:a.mask||"",type:a.type,subtype:a.subtype||"",currency:a.balances.iso_currency_code||a.balances.unofficial_currency_code||null,current:included?a.balances.current:null,available:included?a.balances.available:null,selected:included,blocked};
}
const transactionSchema=z.object({transaction_id:z.string(),account_id:z.string(),date:daySchema,name:z.string(),merchant_name:z.string().nullable().optional(),amount:z.number().finite(),iso_currency_code:z.string().nullable(),unofficial_currency_code:z.string().nullable().optional(),pending:z.boolean(),pending_transaction_id:z.string().nullable().optional(),personal_finance_category:z.object({primary:z.string()}).nullable().optional()});
export function normalizeTransaction(value:unknown,itemId:string,accountId:string):Transaction {
  const t=transactionSchema.parse(value);if(t.account_id!==accountId)throw new Error("Unexpected account in transaction response");
  return {id:t.transaction_id,itemId,accountId,date:t.date,name:t.merchant_name||t.name,amount:t.amount,currency:t.iso_currency_code||t.unofficial_currency_code||null,pending:t.pending,category:t.personal_finance_category?.primary||"UNCATEGORIZED",pendingId:t.pending_transaction_id||null};
}
export const categoryLabel=(category:string)=>category.toLowerCase().replaceAll("_"," ");
export function spendingByCurrency(view:FinanceView,month:string) {
  const result:Record<string,number>={};
  for(const t of view.transactions){
    const note=view.annotations[t.id];
    if(!t.date.startsWith(month)||t.pending||note?.excludeFromSpending||/^(TRANSFER|LOAN_PAYMENTS|INCOME)/.test(t.category))continue;
    const currency=t.currency||"Unknown currency";result[currency]=(result[currency]||0)+t.amount;
  }
  return result;
}
