import { Router } from "express";
import {
  GetCaseDoctorCandidatesParams, GetCaseDoctorCandidatesQueryParams, GetCaseDoctorCandidates200Response,
  ReassignCaseDoctorParams, ReassignCaseDoctorBody, ReassignCaseDoctor200Response,
  UndoCaseDoctorReassignmentParams, UndoCaseDoctorReassignment200Response,
} from "@workspace/api-zod";
import { asyncHandler } from "../middlewares/async-handler";
import { broadcastCaseUpdated } from "../lib/case-events-ws";
import { getCaseDoctorCandidates, reassignCaseDoctor, undoCaseDoctorReassignment } from "../lib/case-doctor-reassignment";

// Mounted inside the cases router, after its auth/verification middleware.
const router = Router();
router.get("/:caseId/doctor-candidates", asyncHandler(async (req, res) => {
  const { caseId } = GetCaseDoctorCandidatesParams.parse(req.params);
  const query = GetCaseDoctorCandidatesQueryParams.extend({
    offset: GetCaseDoctorCandidatesQueryParams.shape.offset.removeDefault().int().default(0),
    limit: GetCaseDoctorCandidatesQueryParams.shape.limit.removeDefault().int().default(50),
  }).parse(req.query);
  const data = await getCaseDoctorCandidates((req as any).auth.userId, caseId, query);
  res.json(GetCaseDoctorCandidates200Response.parse({ ok: true, data }));
}));
router.post("/:caseId/doctor-reassignment", asyncHandler(async (req, res) => {
  const { caseId } = ReassignCaseDoctorParams.parse(req.params);
  const input = ReassignCaseDoctorBody.strict().parse(req.body);
  const data = await reassignCaseDoctor(req, caseId, input);
  broadcastCaseUpdated(caseId, "case_doctor_reassigned");
  res.json(ReassignCaseDoctor200Response.parse({ ok: true, data }));
}));
router.post("/:caseId/doctor-reassignment/:auditLogId/undo", asyncHandler(async (req, res) => {
  const { caseId, auditLogId } = UndoCaseDoctorReassignmentParams.parse(req.params);
  const data = await undoCaseDoctorReassignment(req, caseId, auditLogId);
  broadcastCaseUpdated(caseId, "case_doctor_reassignment_undone");
  res.json(UndoCaseDoctorReassignment200Response.parse({ ok: true, data }));
}));
export default router;
