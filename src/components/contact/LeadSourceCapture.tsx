"use client";

import { useEffect } from "react";
import { captureLeadSource } from "./lead-source";

/** Mounted once in the root layout so attribution reflects the true landing page. */
export function LeadSourceCapture() {
  useEffect(() => {
    captureLeadSource();
  }, []);
  return null;
}
