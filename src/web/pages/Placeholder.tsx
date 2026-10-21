export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-[var(--fg-muted)]">{note}</p>
    </div>
  );
}
