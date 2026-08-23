import Link from "next/link";
import { CalendarIcon, ChartIcon, ChatIcon, SettingsIcon, SparklesIcon } from "@/components/icons";

const links = [
  { href: "/dashboard", label: "Console", Icon: ChatIcon, active: true },
  { href: "/dashboard/proposals", label: "Proposals", Icon: SparklesIcon },
  { href: "/dashboard/calendar", label: "Calendar", Icon: CalendarIcon },
  { href: "/dashboard/monitoring", label: "Monitoring", Icon: ChartIcon },
  { href: "/dashboard/settings", label: "Settings", Icon: SettingsIcon },
];

export function StudioNavRail() {
  return (
    <nav className="hidden h-full flex-col items-center gap-1 bg-[#11110f] py-4 text-white lg:flex" aria-label="Primary">
      <Link href="/" aria-label="Harmonia home" className="mb-7 grid h-9 w-9 -rotate-6 place-items-center rounded-full bg-[#d8ff3e] text-sm font-black text-[#11110f]">H</Link>
      {links.map(({ href, label, Icon, active }) => <Link key={href} href={href} title={label} aria-label={label} className={`grid h-10 w-10 place-items-center rounded-[13px] transition ${active ? "bg-[#30302b] text-[#d8ff3e]" : "text-[#85857f] hover:bg-[#292925] hover:text-white"}`}><Icon /></Link>)}
      <span aria-label="Operator profile" className="mt-auto h-9 w-9 rounded-full bg-gradient-to-br from-[#ff765f] to-[#a566ff] ring-2 ring-white" />
    </nav>
  );
}
