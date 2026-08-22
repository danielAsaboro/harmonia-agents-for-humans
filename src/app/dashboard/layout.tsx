import NavRail from "@/components/NavRail";
import ChatDrawer from "@/components/ChatDrawer";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen pl-20 sm:pl-24">
      <NavRail />
      <main className="mx-auto w-full max-w-6xl">{children}</main>
      {/* Global floating chat; any surface can scope it via askAiAbout(). */}
      <ChatDrawer />
    </div>
  );
}
