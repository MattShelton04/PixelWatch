import { describe, expect, it } from "vitest";
import { ingestArtifacts } from "../src/ingest/ingest.ts";
import { selectArtifacts } from "../src/ingest/select.ts";
import { decodePng } from "../src/png/decode.ts";
import { encodePng } from "../src/png/encode.ts";
import type { ArtifactInput } from "../src/ingest/types.ts";
import { artifact, config, memoryPool } from "./ingest-fixtures.ts";
import { CANARY_TOKEN, SIGNED_URL, assertNoSecrets } from "../../../tools/simulation/capture.ts";

const part=(index:number,count=1,id=String(index))=>artifact({attempt:"7",revision:"head",providerId:"p",shard:[index,count],units:[{viewId:`view-${String(index)}`,state:"captured"}]},{id});
const metadata=(value:ArtifactInput)=>({artifactId:value.artifactId,artifactName:value.artifactName});

describe("API artifact metadata selection",()=>{
  it("selects original metadata descriptors without reading archive bytes before download",()=>{
    let opened=0;
    const selected={...metadata(part(1)),sizeBytes:123,expired:false,get zip(){opened++;throw new Error("archive-not-downloaded");}};
    const other={artifactId:"2",artifactName:"unrelated",sizeBytes:456,expired:false,get zip(){opened++;throw new Error("archive-not-downloaded");}};
    const result=selectArtifacts({config:config([["p",1]]),attempt:"7",baseline:"none",artifacts:[other,selected]});
    expect(result.selected[0]?.artifact).toBe(selected);expect(result.ignored.map(value=>value.artifactId)).toEqual(["2"]);expect(opened).toBe(0);
  });
  it("preserves listed duplicates ignored artifacts and missing downloads without invented archives",async()=>{
    const duplicate=part(1,3,"1"),missing=part(2,3,"3"),good=part(3,3,"4");
    let opened=0,decoded=0;
    const listedArtifacts=[metadata(duplicate),{...metadata(duplicate),artifactId:"2"},metadata(missing),metadata(good),{artifactId:"5",artifactName:"unrelated",get zip(){opened++;throw new Error("do-not-open");}}];
    const pool=memoryPool();
    const result=await ingestArtifacts({config:config([["p",3]]),attempt:"7",baseline:"none",artifacts:[good],listedArtifacts,pool,codec:{decode(bytes){decoded++;return decodePng(bytes);},encode:encodePng},deadline:new AbortController().signal});
    expect(result.parts.map(value=>[value.status,value.artifacts.map(ref=>ref.artifactId)])).toEqual([["rejected",["1","2"]],["not-received",[]],["valid",["4"]]]);
    expect(result.parts[0]?.diagnostic?.code).toBe("part-duplicate");expect(result.ignored.map(value=>[value.artifactId,value.reason])).toEqual([["5","not-pixelwatch"]]);
    expect(result.coverage.status).toBe("incomplete");expect(result.units.map(value=>value.viewId)).toEqual(["view-3"]);expect(decoded).toBe(1);expect(opened).toBe(0);
  });
  it.each(["unlisted","renamed","repeated","duplicate-part","ignored"] as const)("refuses downloaded %s metadata before reading any ZIP or writing a blob",async(kind)=>{
    const good=part(1,2,"1"),other=part(2,2,"2");let opened=0,decoded=0;
    const listedArtifacts=[metadata(good),metadata(other)];
    let downloaded:ArtifactInput=other;
    if(kind==="unlisted")downloaded={...other,artifactId:"99"};
    if(kind==="renamed")downloaded={...other,artifactName:other.artifactName.replace("a7-","a8-")};
    if(kind==="repeated")downloaded=good;
    if(kind==="duplicate-part")listedArtifacts.push({...metadata(other),artifactId:"3"});
    if(kind==="ignored"){listedArtifacts[1]={artifactId:"2",artifactName:"unrelated"};downloaded={...other,artifactName:"unrelated"};}
    Object.defineProperty(downloaded,"zip",{get(){opened++;throw new Error(`${CANARY_TOKEN} ${SIGNED_URL}`);}});
    const pool=memoryPool();
    const error:unknown=await ingestArtifacts({config:config([["p",2]]),attempt:"7",baseline:"none",artifacts:[good,downloaded],listedArtifacts,pool,codec:{decode(bytes){decoded++;return decodePng(bytes);},encode:encodePng},deadline:new AbortController().signal}).catch((caught:unknown)=>caught);
    expect(error).toMatchObject({code:"ingest-selection-invalid",scope:"ingestion"});
    expect(error).toBeInstanceOf(Error);if(!(error instanceof Error))throw new Error("expected fixed refusal");
    assertNoSecrets([error.message,error.stack??"",JSON.stringify(error)]);expect(error.cause).toBeUndefined();
    expect(opened).toBe(0);expect(decoded).toBe(0);expect(pool.blobs.size).toBe(0);
  });
  it("still refuses a selected unknown bundle version before decoding a valid downloaded sibling",async()=>{
    const good=part(1,2,"1"),future=artifact({attempt:"7",revision:"head",providerId:"p",shard:[2,2],units:[{viewId:"future",state:"captured"}]},{id:"2",edit:value=>({...value,schemaVersion:2})});
    const pool=memoryPool();let decoded=0;
    await expect(ingestArtifacts({config:config([["p",2]]),attempt:"7",baseline:"none",artifacts:[good,future],listedArtifacts:[metadata(future),metadata(good)],pool,codec:{decode(bytes){decoded++;return decodePng(bytes);},encode:encodePng},deadline:new AbortController().signal})).rejects.toMatchObject({code:"ingest-unsupported-version",scope:"ingestion"});
    expect(decoded).toBe(0);expect(pool.blobs.size).toBe(0);
  });
});
