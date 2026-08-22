import NavRail from "@/components/NavRail";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen pl-20 sm:pl-24">
      <NavRail />
      <main className="mx-auto w-full max-w-6xl">{children}</main>
    </div>
  );
}
