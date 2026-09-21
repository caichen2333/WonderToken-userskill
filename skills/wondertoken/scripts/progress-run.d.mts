export function pendingRunOutput(value: { tool: string; operationId: string }): {
  schemaVersion: "progress-run-local-v1";
  data: null;
  pending: { tool: string; operationId: string };
};
export function formatTravelDays(value: number): string;
export function renderDelivery(value: unknown): string;
