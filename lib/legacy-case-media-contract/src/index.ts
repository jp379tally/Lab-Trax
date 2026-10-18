export interface MigratedLegacyPhotoInput {
  eventId: string;
  fileName: string;
  occurredAt: string;
}

export interface MigratedLegacyPhotoAttachment {
  id: string;
  caseId: string;
  fileName: string;
  fileType: "image/jpeg";
  storageKey: string;
  url: string;
}

export interface MigratedLegacyPhotoEvent {
  id: string;
  eventType: "attachment_added";
  metadataJson: {
    description: "Photo added";
    mediaKind: "photo";
    imageUri: string;
    fileName: string;
    fileType: "image/jpeg";
  };
  occurredAt: string;
}

export interface MigratedLegacyPhotoContract {
  caseId: string;
  attachments: MigratedLegacyPhotoAttachment[];
  events: MigratedLegacyPhotoEvent[];
}

export function legacyPhotoReference(fileName: string): string {
  return `/api/cases/attachment-file/${encodeURIComponent(fileName)}`;
}

/**
 * Shared regression contract for the legacy-case detail projection.
 *
 * The server test validates its real projection against this shape. Mobile and
 * desktop tests consume the same shape so changes to ids, relative references,
 * display filenames, or history metadata cannot drift independently.
 */
export function buildMigratedLegacyPhotoContract(
  caseId: string,
  photos: readonly MigratedLegacyPhotoInput[],
): MigratedLegacyPhotoContract {
  return {
    caseId,
    attachments: photos.map((photo, index) => {
      const reference = legacyPhotoReference(photo.fileName);
      return {
        id: `legacy-photo-${caseId}-${index}`,
        caseId,
        fileName: `mobile-photo-${index + 1}`,
        fileType: "image/jpeg",
        storageKey: reference,
        url: reference,
      };
    }),
    events: photos.map((photo) => ({
      id: photo.eventId,
      eventType: "attachment_added",
      metadataJson: {
        description: "Photo added",
        mediaKind: "photo",
        imageUri: legacyPhotoReference(photo.fileName),
        fileName: photo.fileName,
        fileType: "image/jpeg",
      },
      occurredAt: photo.occurredAt,
    })),
  };
}

export const migratedLegacyPhotoContract = buildMigratedLegacyPhotoContract(
  "case-migrated-legacy-media",
  [
    {
      eventId: "evt-migrated-occlusal",
      fileName: "migrated-occlusal.jpg",
      occurredAt: "2024-01-12T12:00:00.000Z",
    },
    {
      eventId: "evt-migrated-buccal",
      fileName: "migrated-buccal.jpg",
      occurredAt: "2024-01-12T12:01:00.000Z",
    },
  ],
);

export interface MigratedLegacyVideoInput {
  eventId: string;
  fileName: string;
  occurredAt: string;
}

export interface MigratedLegacyVideoAttachment {
  id: string;
  caseId: string;
  fileName: string;
  fileType: "video/mp4";
  storageKey: string;
  url: string;
}

export interface MigratedLegacyVideoEvent {
  id: string;
  eventType: "attachment_added";
  metadataJson: {
    description: "Video added";
    mediaKind: "video";
    imageUri: string;
    fileName: string;
    fileType: "video/mp4";
  };
  occurredAt: string;
}

export interface MigratedLegacyVideoContract {
  caseId: string;
  attachments: MigratedLegacyVideoAttachment[];
  events: MigratedLegacyVideoEvent[];
}

/** Server-projected legacy videos use the same relative attachment-file route as photos. */
export function buildMigratedLegacyVideoContract(
  caseId: string,
  videos: readonly MigratedLegacyVideoInput[],
): MigratedLegacyVideoContract {
  return {
    caseId,
    attachments: videos.map((video, index) => {
      const reference = legacyPhotoReference(video.fileName);
      return {
        id: `legacy-video-${caseId}-${index}`,
        caseId,
        fileName: `mobile-video-${index + 1}`,
        fileType: "video/mp4",
        storageKey: reference,
        url: reference,
      };
    }),
    events: videos.map((video) => ({
      id: video.eventId,
      eventType: "attachment_added",
      metadataJson: {
        description: "Video added",
        mediaKind: "video",
        imageUri: legacyPhotoReference(video.fileName),
        fileName: video.fileName,
        fileType: "video/mp4",
      },
      occurredAt: video.occurredAt,
    })),
  };
}

export const migratedLegacyVideoContract = buildMigratedLegacyVideoContract(
  "case-migrated-legacy-video",
  [
    {
      eventId: "evt-migrated-bite-video",
      fileName: "migrated-bite clip.mp4",
      occurredAt: "2024-01-12T12:03:00.000Z",
    },
    {
      eventId: "evt-migrated-shade-video",
      fileName: "migrated-shade.mp4",
      occurredAt: "2024-01-12T12:04:00.000Z",
    },
  ],
);