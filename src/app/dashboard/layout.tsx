import NavRail from "@/components/NavRail";
import DashboardFrame from "@/components/DashboardFrame";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen pl-0 sm:pl-24">
      <NavRail />
      <DashboardFrame>{children}</DashboardFrame>
    </div>
  );
}
