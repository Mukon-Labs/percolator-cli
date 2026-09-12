import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planClockMaintenance, maintainBeforeLp, decodeMaintenanceResponse } from "./keeper-maintenance.ts";
import { KeeperFailure, SingleTickRunner, PendingBroadcastGate } from "./keeper-runtime.ts";

function fixture(slots = [1000n, 1000n, 1000n], lifecycle = slots.map(() => 2)) {
  const market = new Uint8Array(32).fill(7);
  const data = Buffer.alloc(1190 + slots.length * 1797);
  data.writeBigUInt64LE(0x5045524356313600n, 0); data.writeUInt16LE(16, 8); data[10] = 1;
  data.set(market, 464); data.writeUInt32LE(slots.length, 464 + 281);
  data.writeBigUInt64LE(1000n, 464 + 581); data.writeBigUInt64LE(20n, 614);
  slots.forEach((slot, i) => { data[1190+i*1797+512+16] = lifecycle[i]; data.writeBigUInt64LE(slot,1190+i*1797+512+41); });
  return { marketData: data, expectedMarket: market, contextSlot: 1030n,
    minimumContextSlot: 1020n, pushedAssetIndexes: [0,1,2] };
}

test("fresh head context triggers proactive work even with a clear lock and zero market-relative debt", () => {
  const p = planClockMaintenance(fixture());
  assert.equal(p.cranks, 4); assert.equal(p.maxDebtSlots, 30n);
  assert.equal(p.maxAccrualDtSlots,20n); assert.equal(p.capped,false);
});
test("RPC response must have the expected owner, encoding and safe fresh context",()=>{
  const f=fixture();
  const input={...f,expectedOwner:"expected-program"};
  const response={result:{context:{slot:1030},value:{owner:"expected-program",data:[f.marketData.toString("base64"),"base64"]}}};
  assert.equal(decodeMaintenanceResponse(response,input).cranks,4);
  for(const payload of [null,{}, {error:{code:429}},
    {result:{...response.result,value:{...response.result.value,owner:"wrong"}}},
    {result:{...response.result,value:{...response.result.value,data:["bad","json"]}}},
    {result:{...response.result,context:{slot:"1030"}}},
    {result:{...response.result,context:{slot:Number.MAX_SAFE_INTEGER+1}}},
    {result:{...response.result,context:{slot:1019}}},
  ]) assert.throws(()=>decodeMaintenanceResponse(payload,input));
});
test("slow slots reduce work; healthy decisions are never cached", () => {
  const f = fixture(); f.contextSlot=1000n; f.minimumContextSlot=1000n;
  assert.equal(planClockMaintenance(f).cranks,2);
  f.contextSlot=1040n;
  assert.equal(planClockMaintenance(f).cranks,4);
  f.marketData.writeBigUInt64LE(100n,614);
  assert.equal(planClockMaintenance(f).cranks,1);
});
test("worst eligible asset controls planning, not the LP-selected first asset", () => {
  const p = planClockMaintenance(fixture([1000n, 940n, 960n]));
  assert.equal(p.maxDebtSlots,90n); assert.equal(p.cranks,7);
});
test("large debt is bounded to the existing nine-crank envelope", () => {
  const p=planClockMaintenance(fixture([0n,0n,0n]));
  assert.equal(p.cranks,9); assert.equal(p.capped,true);
});
test("Recovery/retired assets and unavailable feeds are excluded, drain-only included", () => {
  const f=fixture([1000n,990n,0n,0n,0n],[2,3,5,4,2]);
  f.pushedAssetIndexes=[0,1,2,3];
  const p=planClockMaintenance(f);
  assert.deepEqual(p.assetIndexes,[0,1]); assert.deepEqual(p.blockedAssetIndexes,[4]);
  assert.equal(p.maxDebtSlots,40n);
  f.pushedAssetIndexes=[]; assert.equal(planClockMaintenance(f).cranks,0);
});
test("parser rejects wrong identity, layout, lifecycle, cap and stale/inconsistent context", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.expectedMarket=new Uint8Array(32); },
    (f: ReturnType<typeof fixture>) => { f.marketData=f.marketData.subarray(0,-1); },
    (f: ReturnType<typeof fixture>) => { f.marketData[1190+512+16]=6; },
    (f: ReturnType<typeof fixture>) => { f.marketData.writeBigUInt64LE(0n,614); },
    (f: ReturnType<typeof fixture>) => { f.contextSlot=999n; },
    (f: ReturnType<typeof fixture>) => { f.minimumContextSlot=1040n; },
    (f: ReturnType<typeof fixture>) => { f.pushedAssetIndexes=[0,0]; },
    (f: ReturnType<typeof fixture>) => { f.pushedAssetIndexes=[3]; },
    (f: ReturnType<typeof fixture>) => { f.marketData.writeBigUInt64LE(1001n,1190+512+41); },
  ]) { const f=fixture(); mutate(f); assert.throws(()=>planClockMaintenance(f)); }
});

// Model the engine's per-asset min(dt, cap) rule, NOT future clock advancement.
// Distinct from a real SBF/CU test; regression verifies the scheduler's capacity.
for (const slotsPerTick of [30n,40n]) test(`sustained ${slotsPerTick} slots/tick stays current after maintenance`, () => {
  let slots=[1000n,1000n,1000n], now=1000n;
  for (let tick=0;tick<500;tick++) {
    now+=slotsPerTick;
    const f=fixture(slots); f.marketData.writeBigUInt64LE(now,464+581);
    f.contextSlot=now; f.minimumContextSlot=now;
    const p=planClockMaintenance(f);
    const executionSlot=now+35n; // within explicit40-slot execution allowance
    slots=slots.map(s=>s+((executionSlot-s)<20n*BigInt(p.cranks)?executionSlot-s:20n*BigInt(p.cranks)));
    assert.ok(slots.every(s=>s===executionSlot));
    assert.ok(p.cranks<=9);
    now=executionSlot;
  }
});
test("a forty-second gap recovers over bounded ticks without pretending the first batch is enough", () => {
  let slots=[1000n,1000n,1000n], now=1240n, caughtUp=false;
  for(let tick=0;tick<5;tick++) {
    const f=fixture(slots); f.marketData.writeBigUInt64LE(now,464+581);
    f.contextSlot=now; f.minimumContextSlot=now;
    const p=planClockMaintenance(f); if(tick===0)assert.equal(p.capped,true);
    slots=slots.map(s=>s+(now-s<20n*BigInt(p.cranks)?now-s:20n*BigInt(p.cranks)));
    if(slots.every(s=>s===now)){caughtUp=true;break;}
    now+=40n;
  }
  assert.equal(caughtUp,true);
});
test("legacy one-crank cadence accumulates debt at thirty slots/tick", () => {
  let state=1000n, now=1000n;
  for(let i=0;i<6;i++){now+=30n;state+=20n;}
  assert.equal(now-state,60n);
});
test("one fresh plan, one independent batch, then LP in that order", async () => {
  const calls:string[]=[]; const plan=planClockMaintenance(fixture());
  const result=await maintainBeforeLp({signal:new AbortController().signal,
    readPlan:async()=>{calls.push("read");return plan;},
    maintain:async()=>{calls.push("maintain-confirmed");},
    crankLp:async()=>{calls.push("lp");return 7;}});
  assert.equal(result,7); assert.deepEqual(calls,["read","maintain-confirmed","lp"]);
});
for (const kind of ["rate_limit","pending","timeout","onchain"] as const) test(`${kind} stops LP and does not start a second batch`,async()=>{
  let batches=0,lp=0;const failure=new KeeperFailure(kind,"test");
  await assert.rejects(maintainBeforeLp({signal:new AbortController().signal,
    readPlan:async()=>planClockMaintenance(fixture()),maintain:async()=>{batches++;throw failure;},
    crankLp:async()=>{lp++;}}),e=>e===failure);
  assert.equal(batches,1);assert.equal(lp,0);
});
test("failed fresh read never reuses an earlier successful plan",async()=>{
  let sends=0;await assert.rejects(maintainBeforeLp({signal:new AbortController().signal,
    readPlan:async()=>{throw new KeeperFailure("rate_limit","probe");},
    maintain:async()=>{sends++;},crankLp:async()=>{sends++;}}));assert.equal(sends,0);
});
test("cancellation after maintenance prevents LP work",async()=>{
  const c=new AbortController();let lp=0;
  await assert.rejects(maintainBeforeLp({signal:c.signal,readPlan:async()=>planClockMaintenance(fixture()),
    maintain:async()=>{c.abort();},crankLp:async()=>{lp++;}}));assert.equal(lp,0);
});
test("LP failure cannot roll back an independently confirmed batch or cause another batch",async()=>{
  let batches=0;
  await assert.rejects(maintainBeforeLp({signal:new AbortController().signal,readPlan:async()=>planClockMaintenance(fixture()),
    maintain:async()=>{batches++;},crankLp:async()=>{throw new Error("LP failure");}}));assert.equal(batches,1);
});
test("production wiring performs maintenance after push and before LP without legacy cached heal",()=>{
  const s=readFileSync(new URL("./oracle-keeper-v16.ts",import.meta.url),"utf8");
  assert.ok(s.indexOf("const push = await pushAssetsWithIsolation")<s.indexOf("const crank = await maintainBeforeLp"));
  assert.match(s,/maintain: \(plan\) => maintainClocks\(plan, signal\)/);
  assert.doesNotMatch(s,/knownMarketNeedsCatchUp|nextMarketStatusCheckMs|await selfHeal/);
  assert.ok(s.indexOf("const crank = await maintainBeforeLp")<s.indexOf("if (shouldResetRpcCircuitAfterPush"));
});

test("slow maintenance retains the singleton tick guard and original pending signature",async()=>{
  const runner=new SingleTickRunner(); const gate=new PendingBroadcastGate<string>();
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  let lp=0;
  const first=runner.run(signal=>maintainBeforeLp({signal,
    readPlan:async()=>planClockMaintenance(fixture()),
    maintain:async()=>{
      gate.record({context:"maintenance",rawTransaction:Uint8Array.of(1,2,3),
        strategy:{signature:"original",blockhash:"hash",lastValidBlockHeight:200}});
      entered();await waiting;throw new KeeperFailure("pending","still unconfirmed");
    },crankLp:async()=>{lp++;}}));
  await started;
  assert.equal(await runner.run(async()=>{throw new Error("overlap");}),false);
  assert.equal(gate.snapshot()?.strategy.signature,"original");
  release();await assert.rejects(first);
  assert.equal(lp,0);assert.equal(gate.snapshot()?.strategy.signature,"original");
  assert.throws(()=>gate.record({context:"replacement",rawTransaction:Uint8Array.of(4),
    strategy:{signature:"new",blockhash:"hash",lastValidBlockHeight:201}}));
});
