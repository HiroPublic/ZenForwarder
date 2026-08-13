export type ReservationStatus = "Confirmed" | "Modified" | "Cancelled" | "Price Alert";

export type EmailType =
  | "Reservation Confirmation"
  | "Change Notice"
  | "Cancellation Notice"
  | "HotelSlash Price Alert"
  | "Low Price Proposal"
  | "Proposal accepted"
  | "Proposal Unaccepted";

export type ProcessingState = "pending" | "processed" | "error";

export interface ReservationMetadata {
  hotelName: string;
  hotelAddress?: string;
  hotelPhone?: string;
  bookingSite?: string;
  reservationNumber?: string;
  guestName?: string;
  adultCount?: number;
  childCount?: number;
  reservationConfirmationUrl?: string;
  status: ReservationStatus;
  emailType: EmailType;
  checkIn?: string;
  checkOut?: string;
  nights?: number;
  room?: string;
  mealPlan?: string;
  originalCurrency?: string;
  originalAmount?: number;
  jpyAmount?: number;
  exchangeRate?: number;
  exchangeRateDate?: string;
  cancellationPolicy?: string;
  notes?: string;
  relatedReservationId?: string;
}

export interface LowPriceProposal {
  pageUrl: string;
  priceCurrency: string;
  priceAmount: number;
  roomType: string;
  conditions: string[];
  currentReservation?: CurrentReservationInfo;
  previousProposal?: PreviousProposal;
  notionPageId?: string;
  hotelArrangement?: boolean;
  bookingSite?: string;
}

export interface UnavailableLowPriceProposal {
  requestedUrl: string;
  finalUrl: string;
  pageTitle?: string;
  message: string;
}

export interface CurrentReservationInfo {
  priceCurrency?: string;
  priceAmount?: number;
  roomType?: string;
  conditions?: string[];
  cancellationDeadline?: string;
  paymentTerms?: string;
}

export interface PreviousProposal {
  pageId: string;
  title: string;
  receivedAt?: string;
  priceCurrency?: string;
  priceAmount?: number;
  roomType?: string;
  conditions?: string[];
  emailType?: EmailType;
}

export interface AuditEvent {
  at: string;
  step: string;
  status: "ok" | "error" | "info";
  message: string;
  details?: Record<string, unknown>;
}

export interface PendingForward {
  id: string;
  kind?: "forward" | "lowPriceProposal" | "unavailableLowPriceProposal";
  gmailMessageId: string;
  gmailUrl: string;
  from: string;
  receivedAt: string;
  subject: string;
  metadata: ReservationMetadata;
  generatedSubject: string;
  generatedBody: string;
  internalJson: ReservationMetadata;
  proposal?: LowPriceProposal;
  unavailableProposal?: UnavailableLowPriceProposal;
  state: ProcessingState;
  auditLog: AuditEvent[];
}

export interface SyncError {
  gmailMessageId: string;
  from: string;
  receivedAt: string;
  subject: string;
  message: string;
}

export interface SyncReservationsResult {
  items: PendingForward[];
  errors: SyncError[];
}

export interface SyncProgress {
  active: boolean;
  stage: string;
  currentStepLabel?: string;
  currentStepIndex: number;
  currentStepTotal: number;
  totalCandidates: number;
  completedCandidates: number;
  failedCandidates: number;
  currentIndex: number;
  currentEmailId?: string;
  currentEmailSubject?: string;
  currentEmailFrom?: string;
  startedAt?: string;
  lastUpdatedAt: string;
}

export interface ForwardResult {
  item: PendingForward;
  tripItSentAt: string;
  hotelSlashSentAt: string;
  notionPageId?: string;
}

export interface NotionOnlyResult {
  item: PendingForward;
  notionPageId?: string;
  hotelArrangement: boolean;
}
