"use client";

import { usePathname } from "next/navigation";
import ChatDrawer from "@/components/ChatDrawer";
import NavRail from "@/components/NavRail";

export default function DashboardFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isStudio = pathname === "/dashboard" || pathname === "/dashboard/";
  return (
    <>
      <NavRail />
      <main className={isStudio ? "h-dvh w-full overflow-hidden" : "min-h-screen"}>
        <div className={isStudio ? "h-full" : "mx-auto w-full max-w-6xl"}>{children}</div>
      </main>
      {!isStudio ? <ChatDrawer /> : null}
    </>
  );
}
