export const INBOX_DRAG_MIME="application/x-labtrax-inbox+json";
export const INBOX_INTAKE_EVENT="labtrax:inbox-intake";
export type InboxDragPayload={labOrganizationId:string;documentIds:string[]};
export type PreparedInboxIntake={labOrganizationId:string;prescriptionDocumentId:string|null;documents:Array<{id:string;fileName:string;mimeType:string;sizeBytes:number}>};

export function parseInboxDragPayload(raw:unknown):InboxDragPayload|null {
  if(typeof raw!=="string"||raw.length>4096)return null;
  try {
    const value=JSON.parse(raw);const identifier=(id:unknown)=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
    if(!value || typeof value!=="object" || Object.keys(value).sort().join(",")!=="documentIds,labOrganizationId" || !identifier(value.labOrganizationId) || !Array.isArray(value.documentIds) || value.documentIds.length<1 || value.documentIds.length>13 || !value.documentIds.every(identifier) || new Set(value.documentIds).size!==value.documentIds.length)return null;
    return {labOrganizationId:value.labOrganizationId,documentIds:value.documentIds};
  }catch{return null;}
}

/** Retain the confirmed Case ID when only linking fails. Retain an ambiguous
 * creation failure too: a timeout must not silently POST another case/invoice. */
export function createInboxCaseTransfer() {
  type Created={id:string;caseNumber:string};
  let createPromise:Promise<Created>|null=null,createdValue:Created|null=null,inFlight:Promise<Created>|null=null;
  return {
    created:()=>createdValue,
    resetRejectedCreation(){if(!createdValue&&!inFlight)createPromise=null;},
    async complete(create:()=>Promise<Created>,link:(caseId:string)=>Promise<unknown>):Promise<Created> {
      if(inFlight)return inFlight;
      inFlight=(async()=>{
        createPromise??=Promise.resolve().then(create);
        const created=await createPromise;
        if(!created.id)throw new Error("The server did not confirm a case identifier. Check the case list before trying again.");
        createdValue=created;
        await link(created.id);return created;
      })();
      try{return await inFlight;}finally{inFlight=null;}
    },
  };
}
