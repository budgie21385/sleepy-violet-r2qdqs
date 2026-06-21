// Generic empty-state card with a single CTA. Extracted from App.js.
export function EmptyState({ title, text, action, actionText }) {
  return (
    <div className="rounded-3xl bg-white p-6 text-center shadow-sm border border-neutral-100">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-neutral-600">{text}</p>
      <button
        onClick={action}
        className="mt-5 w-full rounded-2xl bg-[#111111] py-4 font-medium text-white"
      >
        {actionText}
      </button>
    </div>
  );
}
