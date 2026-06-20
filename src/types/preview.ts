// ============================================================================
// Preview Verification Types
// ============================================================================

export interface PreviewVerification {
  previewUrl: string;
  appLoaded: boolean;
  title: string;
  snapshot: string;
  screenshot?: string;
  errors: string[];
}
