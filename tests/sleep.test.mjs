import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildNights, emptySleep, mergeSleepBatch, normalizeSleep, sleepBatchSchema, sleepEpisodes, nightFlags } from '../lib/sleep.ts';

const sample = (start,end,stage,sourceId='watch') => ({id:randomUUID(),start,end,stage,sourceId,sourceName:sourceId});
const context = date => ({date,steps:null,restingHeartRate:null,hrv:null,activeEnergy:null,exerciseMinutes:null,respiratoryRate:null,oxygenSaturation:null});
const overnight = (date,source='watch') => [sample(`${date}T00:00:00Z`,`${date}T02:00:00Z`,'core',source),sample(`${date}T02:00:00Z`,`${date}T03:00:00Z`,'awake',source),sample(`${date}T03:00:00Z`,`${date}T07:00:00Z`,'rem',source)];
test('sleep uses one source, ignores in-bed overlaps, unions duplicates and keeps unspecified sleep distinct',()=>{
  const records=overnight('2026-09-10');records.push({...records[0],id:randomUUID()},sample('2026-09-10T00:00:00Z','2026-09-10T07:00:00Z','inBed'),sample('2026-09-10T00:00:00Z','2026-09-10T07:00:00Z','asleep','phone'));
  const [night]=buildNights(records,'watch','UTC');
  assert.equal(night.asleep,360);assert.equal(night.awake,60);assert.equal(night.awakenings,1);assert.equal(night.longestAwake,60);assert.equal(night.share,360/420*100);
  const [phone]=buildNights(records,'phone','UTC');assert.equal(phone.stages.asleep,420);assert.equal(phone.stages.core,0);assert.equal(phone.awake,null);assert.equal(phone.share,null);
});
test('unknown gaps and contradictory stages do not become awake or sleep',()=>{
  const [night]=buildNights([sample('2026-09-10T00:00:00Z','2026-09-10T02:00:00Z','core'),sample('2026-09-10T03:00:00Z','2026-09-10T07:00:00Z','rem')],'watch','UTC');
  assert.equal(night.unknown,60);assert.equal(night.awake,0);assert.equal(night.share,null);
  assert.equal(nightFlags({...night,asleep:300},emptySleep().settings).short,false);
  const segments=normalizeSleep([sample('2026-09-10T00:00:00Z','2026-09-10T01:00:00Z','core'),sample('2026-09-10T00:30:00Z','2026-09-10T01:00:00Z','awake')]);
  assert.deepEqual(segments.map(s=>s.stage),['core','unknown']);
  assert.equal(buildNights([sample('2026-09-10T00:00:00Z','2026-09-10T07:00:00Z','inBed')],'watch','UTC').length,0);
});
test('partial import boundaries and oversized overlapping sessions cannot create confident short nights or double counts',()=>{
  const [night]=buildNights([sample('2026-09-10T00:00:00Z','2026-09-10T05:00:00Z','core')],'watch','UTC',[{from:'2026-09-10T00:00:00Z',to:'2026-09-11T00:00:00Z'}]);
  assert.equal(night.boundary,true);assert.equal(night.share,null);assert.equal(nightFlags(night,emptySleep().settings).short,false);
  assert.equal(buildNights([sample('2026-09-10T00:00:00Z','2026-09-11T00:00:00Z','asleep'),sample('2026-09-10T23:00:00Z','2026-09-11T00:00:00Z','core')],'watch','UTC').length,0);
});
test('an in-progress night remains partial even when the requested range ends tomorrow',()=>{
  const records=[sample('2026-09-10T23:00:00Z','2026-09-11T02:00:00Z','core')];
  const archive=mergeSleepBatch(emptySleep(),{version:1,generatedAt:'2026-09-11T02:05:00Z',timeZone:'UTC',from:'2026-09-10T00:00:00Z',to:'2026-09-12T00:00:00Z',samples:records,days:[context('2026-09-10'),context('2026-09-11')]});
  const [night]=buildNights(archive.samples,'watch','UTC',archive.ranges);assert.equal(night.boundary,true);assert.equal(nightFlags(night,archive.settings).short,false);
});
test('nights span midnight/DST with elapsed durations and retain separate naps',()=>{
  const records=[sample('2026-11-01T00:00:00-07:00','2026-11-01T06:00:00-08:00','core'),sample('2026-11-01T15:00:00-08:00','2026-11-01T16:00:00-08:00','asleep')];
  const [night]=buildNights(records,'watch','America/Los_Angeles');assert.equal(night.date,'2026-11-01');assert.equal(night.asleep,420);assert.equal(night.otherSleep,60);
  const [midnight]=buildNights([sample('2026-09-10T23:00:00-07:00','2026-09-11T06:00:00-07:00','core')],'watch','America/Los_Angeles');assert.equal(midnight.date,'2026-09-11');assert.equal(midnight.asleep,420);
});
test('missing or unfragmented nights break runs, while personal thresholds distinguish short sleep',()=>{
  const nights=buildNights(['2026-09-01','2026-09-02','2026-09-04','2026-09-05'].flatMap(d=>overnight(d)),'watch','UTC'),settings=emptySleep().settings;
  assert.equal(sleepEpisodes(nights,settings).length,2);assert.deepEqual(sleepEpisodes(nights,settings).map(e=>e.nights.length),[2,2]);
  const [short]=buildNights([sample('2026-09-10T01:00:00Z','2026-09-10T05:00:00Z','asleep')],'watch','UTC');assert.deepEqual(nightFlags(short,settings),{short:true,fragmented:false});
});
test('authoritative batch retries/corrections retain other history, diary and settings',()=>{
  const day='2026-09-10', batch={version:1,generatedAt:'2026-09-11T10:00:00Z',timeZone:'UTC',from:`${day}T00:00:00Z`,to:'2026-09-11T00:00:00Z',samples:overnight(day),days:[context(day)]};
  const old=emptySleep();old.samples=overnight('2026-08-10');old.days=[context('2026-08-10')];old.notes=[{date:day,revision:1,text:'User observation',tags:[],updatedAt:batch.generatedAt}];
  const merged=mergeSleepBatch(old,sleepBatchSchema.parse(batch));assert.equal(merged.samples.length,6);assert.equal(mergeSleepBatch(merged,batch).samples.length,6);
  const corrected=mergeSleepBatch(merged,{...batch,samples:[]});assert.equal(corrected.samples.length,3);assert.equal(corrected.notes[0].text,'User observation');assert.equal(corrected.days.length,2);
  assert.throws(()=>mergeSleepBatch(merged,{...batch,generatedAt:'2026-09-11T09:00:00Z'}),/newer/);
  assert.equal(sleepBatchSchema.safeParse({...batch,days:[]}).success,false);assert.equal(sleepBatchSchema.safeParse({...batch,samples:[...batch.samples,batch.samples[0]]}).success,false);
  assert.equal(sleepBatchSchema.safeParse({...batch,timeZone:'Invalid/Zone'}).success,false);
});
