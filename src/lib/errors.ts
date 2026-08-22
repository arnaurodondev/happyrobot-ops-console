import "server-only";

import { TwinConfigError, TwinQueryError } from "./twin";

export interface DescribedError {
  title: string;
  detail: string;
  hint: string;
}

/**
 * Real error states, not "something went wrong": each one names the cause and
 * the next action. Nothing here echoes the SQL or the API key.
 */
export function describeError(err: unknown): DescribedError {
  if (err instanceof TwinConfigError) {
    return {
      title: "Twin is not configured on this deployment",
      detail: err.message,
      hint: "Set TWIN_API_KEY (a server-only org API key) in the App's environment variables, or in .env.local when running locally, then redeploy.",
    };
  }
  if (err instanceof TwinQueryError) {
    return {
      title: "Twin did not answer",
      detail: err.message,
      hint: "The console reads Twin through POST /api/v2/twin/sql. Check the Twin database status in Settings → Twin Database, then refresh.",
    };
  }
  console.error("[ops-console] unexpected error", err);
  return {
    title: "The console hit an unexpected error",
    detail: err instanceof Error ? err.message : String(err),
    hint: "Refresh the page. If it persists, check the App's build logs.",
  };
}
