"use client";

import { usePathname } from "next/navigation";
import ChatDrawer from "@/components/ChatDrawer";

export default function DashboardFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isStudio = pathname === "/dashboard" || pathname === "/dashboard/";
  return (
    <>
      <main className={isStudio ? "h-dvh w-full overflow-hidden" : "mx-auto w-full max-w-6xl"}>{children}</main>
      {!isStudio ? <ChatDrawer /> : null}
    </>
  );
}
