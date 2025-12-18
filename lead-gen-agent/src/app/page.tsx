import LeadAgent from "@/components/LeadAgent";

export default function Home() {
  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-gradient-to-br from-[#020617] via-[#0B1120] to-[#0f172a] px-5 pb-12 pt-24 text-white sm:px-8 md:px-14">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.15),_transparent_45%),radial-gradient(circle_at_bottom,_rgba(147,51,234,0.15),_transparent_45%)]" />
      <div className="relative mx-auto max-w-6xl">
        <LeadAgent />
      </div>
    </main>
  );
}
