/**
 * Tinker-side re-export of hivemind seat helpers.
 * Keep UI imports short; the contract lives in src/shared/hivemind-seats.ts.
 */
export {
  CONDUCTOR_STORAGE_KEY,
  GATEWAY_TOKEN_STORAGE_KEY,
  OPERATOR_ID_STORAGE_KEY,
  SEAT_ID_STORAGE_KEY,
  TINKER_SEAT_HEADER,
  formatAgentBanner,
  type OperatorId,
  type Seat,
  type SeatId,
} from "../../src/shared/hivemind-seats.ts";
