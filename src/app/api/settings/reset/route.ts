import { NextResponse } from "next/server";
import { resetAppSettings } from "@/db/queries/settings";

export async function POST() {
  const settings = resetAppSettings();
  return NextResponse.json({ settings });
}
