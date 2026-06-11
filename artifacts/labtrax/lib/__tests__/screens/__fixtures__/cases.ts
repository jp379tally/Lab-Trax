// Shared fixtures for the read-only viewer screen smoke tests.
//
// Phase 1 mobile reset: the mobile app is now a thin, read-only viewer over the
// canonical desktop payload (GET /api/cases, GET /api/cases/:id). These fixtures
// model that canonical shape — NOT the retired local-first `LabCase`. The mocked
// `@workspace/api-client-react` hooks in vitest.setup return whatever is seeded
// via `setMockAppState({ cases, invoices })`, so the objects below only need the
// fields the list + detail screens actually read.
//
// NOTE: `caseNumber` carries NO leading "#": both screens render `#${caseNumber}`.

export const inProgressCase = {
  id: "case-in-progress",
  caseNumber: "5001",
  patientFirstName: "Jane",
  patientLastName: "Doe",
  doctorName: "Dr. Smith",
  status: "in_design",
  priority: "standard",
  dueDate: "2024-01-15",
  createdAt: "2024-01-10T12:00:00.000Z",
  updatedAt: "2024-01-11T12:00:00.000Z",
  shade: "A2",
  caseNotes: "Standard zirconia crown",
  restorations: [
    {
      id: "rest-1",
      toothNumber: "8",
      restorationType: "crown",
      restorationSubtype: "full_contour",
      material: "Zirconia",
      shade: "A2",
      quantity: 1,
    },
    {
      id: "rest-2",
      toothNumber: "9",
      restorationType: "crown",
      material: "Zirconia",
      shade: "A2",
      quantity: 1,
    },
  ],
  notes: [
    {
      id: "note-1",
      noteText: "Initial impression looks good",
      visibility: "all",
      authorName: "Alex Brown",
      createdAt: "2024-01-11T09:00:00.000Z",
    },
  ],
  events: [
    {
      id: "evt-1",
      eventType: "created",
      actorName: "Alex Brown",
      occurredAt: "2024-01-10T12:00:00.000Z",
    },
    {
      id: "evt-2",
      eventType: "status_change",
      actorInitials: "AB",
      metadataJson: { fromStatus: "received", toStatus: "in_design" },
      occurredAt: "2024-01-11T08:00:00.000Z",
    },
  ],
};

export const completedCaseWithInvoice = {
  ...inProgressCase,
  id: "case-completed",
  caseNumber: "5002",
  patientFirstName: "John",
  patientLastName: "Roe",
  doctorName: "Dr. Patel",
  status: "complete",
  events: [
    ...inProgressCase.events,
    {
      id: "evt-3",
      eventType: "status_change",
      actorInitials: "AB",
      metadataJson: { fromStatus: "in_design", toStatus: "complete" },
      occurredAt: "2024-01-13T16:00:00.000Z",
    },
  ],
};

export const aiImportedCase = {
  ...inProgressCase,
  id: "case-ai",
  caseNumber: "5003",
  patientFirstName: "Sam",
  patientLastName: "Iverson",
  doctorName: "Dr. Lee",
};

export const sampleInvoice = {
  id: "inv-5002",
  caseId: "case-completed",
  invoiceNumber: "INV-2024-002",
  status: "paid",
  total: 500,
  balanceDue: 0,
  issuedAt: "2024-01-12T00:00:00.000Z",
  dueAt: "2024-02-11T00:00:00.000Z",
  items: [
    {
      id: "li-1",
      description: "Zirconia crown",
      quantity: 2,
      unitPrice: 250,
      lineTotal: 500,
      toothNumbers: "8,9",
    },
  ],
};
