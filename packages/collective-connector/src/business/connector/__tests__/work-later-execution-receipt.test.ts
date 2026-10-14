import {expect, test} from "vitest";
import type {PluginMessage, PluginStorageEntry, PluginTaskReadItem, PluginTaskAdmissionInput} from "@clowder-ai/plugin-sdk";
import {collectiveEventSourceIdentity} from "../../contracts/index.js";
import {collectiveSource} from "../../../collective-ingress-routing.js";
import {createCollectiveWorkAdmissionCaller as sourceCaller} from "../../../collective-work-admission-caller.js";
import {manualWorkFirstReceiptKey} from "../../../owner-work-first-receipt.js";
import {fixture} from "./communication-work-custody.fixture.js";
const compiledCaller = process.env.WORK_LATER_CALLER_MODULE ?? (process.env.OWNER_WORK_CALLER_COMPILED === "1"
  ? new URL("../../../../dist/collective-work-admission-caller.js",import.meta.url).href : undefined);
const createCaller: typeof sourceCaller = compiledCaller ? (await import(compiledCaller)).createCollectiveWorkAdmissionCaller : sourceCaller;

// Actual Service and Connector; Task/message/private-storage ports are explicit
// fixtures. The separate compiled Host probe covers protected execution effects.
async function setup() {
  const f=await fixture();
  await f.connector.adoptWorkPolicy(f.connection.connectionId,"local-owner",f.policy.revision);
  const work=await f.connector.acceptWork(f.source,f.agent,f.input); await f.connector.sync(f.connection.connectionId);
  const records=new Map<string,PluginStorageEntry>(), messages=new Map<string,PluginMessage>();
  let version=0,aggregate=1,created=false; const prepares: PluginTaskAdmissionInput[]=[]; const dispatches: string[]=[];
  const storage={get:async(key:string)=>structuredClone(records.get(key)),compareAndSet:async(key:string,expected:number|null,value:unknown)=>{
    if((records.get(key)?.revision??null)!==expected)return {applied:false};
    records.set(key,{revision:++version,value:structuredClone(value)});return {applied:true,revision:version};}};
  async function publish(eventId:string,id:string) {
    const item=(await f.connector.listInbox(f.connection.connectionId)).find(x=>x.event.eventId===eventId)!;
    const identity=collectiveEventSourceIdentity(item.event)!;
    await f.connector.beginInboxRouting(f.connection.connectionId,eventId,1);
    await f.connector.completeInboxRouting(f.connection.connectionId,eventId,1,{kind:"thread_message",threadId:"channel",messageId:id,catId:identity.catId});
    messages.set(id,{id,threadId:"channel",userId:"local-owner",catId:null,content:item.event.body,
      source:collectiveSource(item.event,identity),timestamp:1,mentions:[],sourceRevision:"revision:"+id});
    return {ownerUserId:"local-owner",identity,sourceMessageId:id,workId:work.workId,destination:{kind:"derived_from_source" as const}};
  }
  const firstSelection=await publish(work.assignmentEventId!,"first");
  const task=():PluginTaskReadItem=>({id:"task",kind:"work",userId:"local-owner",threadId:"child",ownerCatId:f.agent.catId,
    title:work.title,why:work.intendedOutcome,subjectKey:null,status:"todo",createdBy:"system",createdAt:1,updatedAt:1,
    entrustedWork:{revision:aggregate,admission:{sourceRefs:["message:first"]},closure:{state:"open"}}});
  const tasks={get:async()=>created?task():null,listByKind:async()=>created?[task()]:[],
    prepareEntrusted:async(input:PluginTaskAdmissionInput)=>{prepares.push(input);created=true;
      if(input.subject.kind==="continue")expect(input.subject).toEqual({kind:"continue",taskRef:"task:work:task",expectedRevision:aggregate});
      return {result:"admitted" as const,taskRef:"task:work:task",taskRevision:aggregate,threadId:"child",admissionRef:"message:admission",
        executionRef:input.subject.kind==="continue"?"message:second-execution":"message:first-execution"};},
    dispatchEntrusted:async(input:{executionRef:string})=>{dispatches.push(input.executionRef);
      return {messageRef:input.executionRef,entryId:input.executionRef,status:"queued" as const};}};
  const threads={get:async(id:string)=>({id,title:"Work",deepLinkUrl:"https://fixture/"+id,createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]}),
    ensureByKey:async()=>({id:"child",title:"Work",deepLinkUrl:"https://fixture/child",createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]})};
  const options={connector:f.connector,tasks,threads,assertCurrent:async()=>{},firstReceipts:{storage,messaging:{get:async(id:string)=>structuredClone(messages.get(id)??null)}}};
  await createCaller(options).admit(firstSelection);
  const firstKey=manualWorkFirstReceiptKey("local-owner","first",f.agent.catId),first=structuredClone(records.get(firstKey));
  const current=await f.connector.readAssignedWork(f.connection.connectionId,work.workId);
  const continued=await f.connector.continueWork(f.source,f.agent,{workId:work.workId,expectedRevision:current.revision,
    kind:"resume",grantRef:f.input.grantRef,grantRevision:f.input.grantRevision,requestKind:f.input.requestKind});
  await f.connector.sync(f.connection.connectionId);const selection=await publish(continued.executionAuthority!.eventId,"second");
  return {...f,work,continued,selection,options,records,messages,firstKey,first,prepares,dispatches,
    make:()=>createCaller(options),evidence:()=>{aggregate++;}};
}
test("later registered execution stays on its first Task, has a separate receipt/ack and preserves first choice",async()=>{
  const f=await setup();try {f.evidence();const next=await f.make().admit(f.selection);
    expect(next).toMatchObject({taskRef:"task:work:task",taskRevision:2,admissionRef:"message:admission",executionRef:"message:second-execution"});
    expect(f.records.get(f.firstKey)).toEqual(f.first);expect(f.records.size).toBe(2);
    const second=[...f.records].find(([key])=>key!==f.firstKey)![1].value as {kind:string;firstSourceMessageId:string;work:{executionRevision:number};binding:{refScope:string}};
    expect(second.kind).toBe("continued_execution");expect(second.firstSourceMessageId).toBe("first");expect(second.work.executionRevision).toBe(2);
    expect(second.binding.refScope).toContain(":result:1:execution:2:");
    expect((await f.connector.readAssignedWork(f.connection.connectionId,f.work.workId)).executionAuthority?.hostAdmission?.state).toBe("admitted");
  }finally{await f.close();}
});
test("later execution replay after evidence reuses binding and never prepares or rewrites either receipt",async()=>{
  const f=await setup();try {const first=await f.make().admit(f.selection);if(first.result==="needs_clarification")throw Error("Expected fixture admission");const records=structuredClone([...f.records]);f.evidence();
    f.options.tasks.prepareEntrusted=async()=>{throw Error("Bound replay must dispatch the original execution");};
    const next=await f.make().admit(f.selection);expect(next).toMatchObject({executionRef:first.executionRef,taskRevision:first.taskRevision,queue:first.queue});
    expect([...f.records]).toEqual(records);
  }finally{await f.close();}
});
test("package owner branch cannot create a later receipt and only delegates bound dispatch to protected Host",async()=>{
  const f=await setup();try {await f.connector.withAssignedWorkAuthority(f.connection.connectionId,f.work.workId,scope=>
    expect(f.make().admitInScope(scope,f.selection,"owner_request")).rejects.toMatchObject({code:"OWNER_ADMISSION_UNAVAILABLE"}));
    expect(f.prepares).toHaveLength(1);await f.make().admit(f.selection);const before=structuredClone([...f.records]);
    await f.connector.withAssignedWorkAuthority(f.connection.connectionId,f.work.workId,scope=>f.make().admitInScope(scope,f.selection,"owner_request"));
    expect([...f.records]).toEqual(before);
  }finally{await f.close();}
});
test("missing first choice or recalled birth source cannot be recaptured as a later execution",async()=>{
  const f=await setup();try {f.records.delete(f.firstKey);await expect(f.make().admit(f.selection)).rejects.toMatchObject({code:"WORK_TASK_UNAVAILABLE"});
    expect(f.prepares).toHaveLength(1);expect(f.dispatches).toHaveLength(1);
    f.records.set(f.firstKey,f.first!);f.messages.delete("first");await expect(f.make().admit(f.selection)).rejects.toMatchObject({code:"WORK_TASK_UNAVAILABLE"});
    expect(f.records.size).toBe(1);
  }finally{await f.close();}
});
test("new execution never borrows its first Service ack and dispatch waits for fresh exact acknowledgement",async()=>{
  const f=await setup();try {expect(f.continued.executionAuthority?.hostAdmission).toBeUndefined();
    await f.connector.withAssignedWorkAuthority(f.connection.connectionId,f.work.workId,scope=>
      expect(f.make().admitInScope({...scope,recordHostAdmission:async()=>{}},f.selection)).rejects.toMatchObject({code:"OWNER_ADMISSION_UNAVAILABLE"}));
    expect(f.dispatches).toHaveLength(1);expect(f.records.get(f.firstKey)).toEqual(f.first);
    await f.make().admit(f.selection);expect(f.dispatches).toHaveLength(2);expect(f.prepares).toHaveLength(2);
  }finally{await f.close();}
});
