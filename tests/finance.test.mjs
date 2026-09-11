import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinanceService } from '../build/finance.ts';
import { normalizeAccount, spendingByCurrency } from '../lib/finance.ts';

const bankAccount=(id,name,type='depository')=>({account_id:id,name,official_name:null,mask:'1234',type,subtype:type==='credit'?'credit card':'checking',balances:{current:100,available:null,iso_currency_code:'USD'}});
const transaction=(id,amount=20)=>({transaction_id:id,account_id:'personal',date:'2026-09-11',name:'Groceries',amount,iso_currency_code:'USD',pending:false,personal_finance_category:{primary:'FOOD_AND_DRINK'}});
async function harness(){
  const directory=await mkdtemp(join(tmpdir(),'workspace-finance-'));const state={calls:[],failAccounts:false,failPage:false,failRemove:false,removed:false,changes:[],mutation:false};
  const remote=async(url,options)=>{const path=new URL(url).pathname;const input=JSON.parse(options.body);state.calls.push({path,input});let result={};let status=200;
    if(path==='/institutions/get')result={institutions:[]};
    else if(path==='/link/token/create')result={link_token:'fake-link-token'};
    else if(path==='/item/public_token/exchange')result={item_id:input.public_token==='second-token'?'item2':'item1',access_token:'fake-bank-access'};
    else if(path==='/item/get')result={item:{institution_id:'institution1'}};
    else if(path==='/institutions/get_by_id')result={institution:{name:'Personal Bank'}};
    else if(path==='/accounts/get'){if(state.failAccounts){status=400;result={error_code:'ITEM_LOGIN_REQUIRED'};}else result={accounts:[bankAccount('personal','Personal checking'),bankAccount('artek','Artek checking')]};}
    else if(path==='/transactions/sync'){
      assert.equal(input.options.account_id,'personal','only selected personal account may be fetched');
      if(state.failPage&&input.cursor==='partial'){status=400;result={error_code:'PRODUCT_NOT_READY'};}
      else if(state.mutation&&input.cursor==='partial'){state.mutation=false;status=400;result={error_code:'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'};}
      else if(state.failPage||state.mutation)result={added:[transaction('half')],modified:[],removed:[],next_cursor:'partial',has_more:true};
      else result={added:input.cursor?state.changes:[transaction('one')],modified:[],removed:state.changes.length?[{transaction_id:'one'}]:[],next_cursor:'cursor-complete',has_more:false,transactions_update_status:'HISTORICAL_UPDATE_COMPLETE'};
    } else if(path==='/item/remove'){if(state.failRemove){status=400;result={error_code:'ERROR'};}else state.removed=true;}
    else throw new Error('Unexpected provider endpoint '+path);
    return new Response(JSON.stringify(result),{status,headers:{'Content-Type':'application/json'}});
  };
  const app=createFinanceService(directory,remote);const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body={})=>{const r=await fetch(origin+'/api/finance'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  return {state,directory,origin,post,cleanup:async()=>{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}};
}
test('Finance normalizes unknown balances, refunds, currencies, and work exclusions',()=>{
  const a=normalizeAccount(bankAccount('work','Artek credit','credit'),new Set(['work']));assert.equal(a.blocked,true);assert.equal(a.current,null);
  const totals=spendingByCurrency({transactions:[{...transaction('a'),id:'a',date:'2026-09-11',currency:'USD',category:'FOOD_AND_DRINK'},{id:'refund',date:'2026-09-11',amount:-4,currency:'USD',pending:false,category:'FOOD_AND_DRINK'},{id:'other',date:'2026-09-11',amount:8,currency:'CAD',category:'FOOD_AND_DRINK'},{id:'transfer',date:'2026-09-11',amount:100,currency:'USD',category:'TRANSFER_OUT'}],annotations:{}},'2026-09');
  assert.deepEqual(totals,{USD:16,CAD:8});
});
test('Finance scopes account reads, preserves snapshots, and protects connection lifecycle',async()=>{
  const h=await harness();try{
    assert.equal((await h.post('/configure',{clientId:'fake-plaid-client',secret:'fake-plaid-secret',environment:'sandbox'})).status,200);
    const first=await h.post('/exchange',{publicToken:'first-token'});assert.equal(first.data.banks[0].accounts[0].current,null);assert.equal(h.state.calls.some(c=>c.path==='/transactions/sync'),false);
    const duplicate=await h.post('/exchange',{publicToken:'first-token'});assert.equal(duplicate.data.banks.length,1);assert.equal(h.state.calls.filter(c=>c.path==='/item/public_token/exchange').length,1);
    assert.equal((await h.post('/accounts',{itemId:'item1',accountIds:['artek']})).status,400);
    const selected=await h.post('/accounts',{itemId:'item1',accountIds:['personal']});assert.equal(selected.data.transactions.length,1);assert.equal(selected.data.banks[0].accounts[0].current,100);
    const publicText=JSON.stringify(selected.data);assert.equal(publicText.includes('fake-bank-access'),false);assert.equal(publicText.includes('fake-plaid-secret'),false);
    assert.equal((await stat(join(h.directory,'finance.private.json'))).mode&0o777,0o600);
    assert.equal((await h.post('/annotate',{transactionId:'one',category:'Food',note:'Weekly shop',excludeFromSpending:false,revision:0})).status,200);
    assert.equal((await h.post('/annotate',{transactionId:'one',category:'Stale',note:'',excludeFromSpending:false,revision:0})).status,409);
    h.state.failPage=true;const failed=await h.post('/sync');assert.ok(failed.data.banks[0].error);assert.deepEqual(failed.data.transactions.map(t=>t.id),['one']);
    const saved=JSON.parse(await readFile(join(h.directory,'finance.private.json'),'utf8'));assert.equal(saved.items[0].cursors.personal,'cursor-complete');
    h.state.failPage=false;h.state.changes=[{...transaction('posted'),pending_transaction_id:'one'}];const updated=await h.post('/sync');assert.equal(updated.data.annotations.posted.note,'Weekly shop');assert.equal(updated.data.annotations.one,undefined);
    await h.post('/exchange',{publicToken:'second-token'});assert.equal((await h.post('/accounts',{itemId:'item2',accountIds:['personal']})).status,409);
    h.state.failAccounts=true;const cleared=await h.post('/accounts',{itemId:'item1',accountIds:[]});assert.equal(cleared.status,200);assert.equal(cleared.data.transactions.length,0);assert.deepEqual(cleared.data.annotations,{});
    h.state.failRemove=true;assert.equal((await h.post('/disconnect',{itemId:'item1'})).status,502);assert.equal(JSON.parse(await readFile(join(h.directory,'finance.private.json'),'utf8')).items.length,2);
    h.state.failRemove=false;assert.equal((await h.post('/disconnect',{itemId:'item1'})).status,200);assert.equal(h.state.removed,true);
    const blocked=await fetch(h.origin+'/api/finance',{headers:{Origin:'https://example.com'}});assert.equal(blocked.status,403);
  }finally{await h.cleanup();}
});
