"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface AdminCandidateContextValue {
  candidateId: number;
  displayName: string;
}

const AdminCandidateContext = createContext<AdminCandidateContextValue | null>(null);

export function AdminCandidateProvider({ value, children }: { value: AdminCandidateContextValue; children: ReactNode }) {
  return <AdminCandidateContext.Provider value={value}>{children}</AdminCandidateContext.Provider>;
}

export function useAdminCandidate(): AdminCandidateContextValue {
  const value = useContext(AdminCandidateContext);
  if (!value) throw new Error("useAdminCandidate must be used inside the Admin layout");
  return value;
}
