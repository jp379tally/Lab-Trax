import {describe,expect,it,vi} from "vitest";
import {createInboxCaseTransfer,parseInboxDragPayload} from "../inbox-case-transfer";

describe("direct inbox case transfer",()=>{
  it("accepts ID-only payloads and rejects paths, URLs, duplicate IDs and oversized input",()=>{
    expect(parseInboxDragPayload(JSON.stringify({labOrganizationId:"lab",documentIds:["rx"]}))).toEqual({labOrganizationId:"lab",documentIds:["rx"]});
    for(const value of [{labOrganizationId:"lab",documentIds:["https://private/file"]},{labOrganizationId:"lab",documentIds:["rx","rx"]},{labOrganizationId:"lab",documentIds:["rx"],storageKey:"private"},{labOrganizationId:"lab",documentIds:Array.from({length:14},(_,i)=>String(i))}])expect(parseInboxDragPayload(JSON.stringify(value))).toBeNull();
  });
  it("creates once and retries only document linking after the link response is lost",async()=>{
    const transfer=createInboxCaseTransfer();const create=vi.fn(async()=>({id:"case-1",caseNumber:"6001"}));const link=vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({attachmentIds:["a","b","c"]});
    await expect(transfer.complete(create,link)).rejects.toThrow("response lost");expect(transfer.created()).toEqual({id:"case-1",caseNumber:"6001"});
    await transfer.complete(create,link);expect(create).toHaveBeenCalledTimes(1);expect(link).toHaveBeenCalledTimes(2);expect(link.mock.calls[1][0]).toBe("case-1");
  });
  it("coalesces concurrent clicks into one case creation and one link request",async()=>{
    const transfer=createInboxCaseTransfer();const create=vi.fn(async()=>({id:"case-1",caseNumber:"6001"}));const link=vi.fn(async()=>({attachmentIds:["a"]}));
    await Promise.all([transfer.complete(create,link),transfer.complete(create,link)]);expect(create).toHaveBeenCalledTimes(1);expect(link).toHaveBeenCalledTimes(1);
  });
  it("does not create a second case after an ambiguous creation failure",async()=>{
    const transfer=createInboxCaseTransfer();const create=vi.fn().mockRejectedValue(new Error("connection lost"));const link=vi.fn();
    await expect(transfer.complete(create,link)).rejects.toThrow();await expect(transfer.complete(create,link)).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);expect(link).not.toHaveBeenCalled();
  });
});
