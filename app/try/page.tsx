export default function TryPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-16">
      {/* Header */}
      <header className="mb-12">
        <h1
          className="font-bold tracking-tight text-text-primary"
          style={{ fontSize: 'var(--text-page-h1)' }}
        >
          Try Context Listener
        </h1>
        <p
          className="mt-3 text-text-secondary"
          style={{ fontSize: 'var(--text-page-body)' }}
        >
          See how AI context cards look in real time. These are sample cards from an investor podcast.
        </p>
      </header>

      {/* Cards column */}
      <div className="flex flex-col gap-3">

        {/* Person card */}
        <article className="rounded-[var(--radius-card)] border border-border-subtle bg-bg-surface p-5 transition-colors hover:bg-bg-surface-hover">
          <div className="mb-2 flex items-center gap-3">
            <span
              className="rounded-[var(--radius-badge)] px-2 py-0.5 font-bold uppercase tracking-wider text-white"
              style={{
                fontSize: 'var(--text-card-badge)',
                backgroundColor: 'var(--color-entity-person)',
              }}
            >
              Person
            </span>
            <span className="text-text-tertiary" style={{ fontSize: 'var(--text-card-timestamp)' }}>
              2:14
            </span>
          </div>
          <h2
            className="font-semibold text-text-primary"
            style={{ fontSize: 'var(--text-card-title)' }}
          >
            Warren Buffett
          </h2>
          <p
            className="mt-1.5 leading-relaxed text-text-secondary"
            style={{ fontSize: 'var(--text-card-body)' }}
          >
            American business magnate and investor, chairman and CEO of Berkshire Hathaway. Known as the &quot;Oracle of Omaha&quot; for his long-term value investing approach.
          </p>
          <div className="mt-3 flex gap-2">
            <span
              className="cursor-pointer rounded-[var(--radius-badge)] border border-[rgba(99,102,241,0.2)] bg-[rgba(99,102,241,0.08)] px-2 py-1 text-[#a5b4fc] transition-colors hover:bg-[rgba(99,102,241,0.18)]"
              style={{ fontSize: 'var(--text-card-badge)' }}
            >
              Net worth?
            </span>
            <span
              className="cursor-pointer rounded-[var(--radius-badge)] border border-[rgba(99,102,241,0.2)] bg-[rgba(99,102,241,0.08)] px-2 py-1 text-[#a5b4fc] transition-colors hover:bg-[rgba(99,102,241,0.18)]"
              style={{ fontSize: 'var(--text-card-badge)' }}
            >
              Investment philosophy
            </span>
          </div>
        </article>

        {/* Concept card */}
        <article className="rounded-[var(--radius-card)] border border-border-subtle bg-bg-surface p-5 transition-colors hover:bg-bg-surface-hover">
          <div className="mb-2 flex items-center gap-3">
            <span
              className="rounded-[var(--radius-badge)] px-2 py-0.5 font-bold uppercase tracking-wider text-white"
              style={{
                fontSize: 'var(--text-card-badge)',
                backgroundColor: 'var(--color-entity-concept)',
              }}
            >
              Concept
            </span>
            <span className="text-text-tertiary" style={{ fontSize: 'var(--text-card-timestamp)' }}>
              5:38
            </span>
          </div>
          <h2
            className="font-semibold text-text-primary"
            style={{ fontSize: 'var(--text-card-title)' }}
          >
            Compound Interest
          </h2>
          <p
            className="mt-1.5 leading-relaxed text-text-secondary"
            style={{ fontSize: 'var(--text-card-body)' }}
          >
            Interest calculated on the initial principal plus all previously accumulated interest. Often called the &quot;eighth wonder of the world,&quot; it&apos;s the core driver behind long-term wealth accumulation.
          </p>
          <div className="mt-3 flex gap-2">
            <span
              className="cursor-pointer rounded-[var(--radius-badge)] border border-[rgba(99,102,241,0.2)] bg-[rgba(99,102,241,0.08)] px-2 py-1 text-[#a5b4fc] transition-colors hover:bg-[rgba(99,102,241,0.18)]"
              style={{ fontSize: 'var(--text-card-badge)' }}
            >
              Rule of 72
            </span>
            <span
              className="cursor-pointer rounded-[var(--radius-badge)] border border-[rgba(99,102,241,0.2)] bg-[rgba(99,102,241,0.08)] px-2 py-1 text-[#a5b4fc] transition-colors hover:bg-[rgba(99,102,241,0.18)]"
              style={{ fontSize: 'var(--text-card-badge)' }}
            >
              Simple vs compound
            </span>
          </div>
        </article>

        {/* Stock card */}
        <article className="rounded-[var(--radius-card)] border border-border-subtle bg-bg-surface p-5 transition-colors hover:bg-bg-surface-hover">
          <div className="mb-2 flex items-center gap-3">
            <span
              className="rounded-[var(--radius-badge)] px-2 py-0.5 font-bold uppercase tracking-wider text-white"
              style={{
                fontSize: 'var(--text-card-badge)',
                backgroundColor: 'var(--color-entity-stock)',
              }}
            >
              Stock
            </span>
            <span className="text-text-tertiary" style={{ fontSize: 'var(--text-card-timestamp)' }}>
              8:02
            </span>
          </div>
          <h2
            className="font-semibold text-text-primary"
            style={{ fontSize: 'var(--text-card-title)' }}
          >
            AAPL
          </h2>
          <p
            className="mb-3 text-text-secondary"
            style={{ fontSize: 'var(--text-card-body)' }}
          >
            Apple Inc.
          </p>
          <div className="flex items-baseline gap-3">
            <span
              className="font-bold text-text-primary"
              style={{ fontSize: 'var(--text-stock-price)' }}
            >
              $178.42
            </span>
            <span
              className="font-semibold text-entity-stock"
              style={{ fontSize: 'var(--text-stock-change)' }}
            >
              +2.31%
            </span>
          </div>
          {/* 52-week bar */}
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-text-tertiary" style={{ fontSize: '11px' }}>
              <span>52W Low: $124.17</span>
              <span>52W High: $199.62</span>
            </div>
            <div className="relative h-1 rounded-[var(--radius-tiny)] bg-[rgba(255,255,255,0.08)]">
              <div
                className="absolute left-0 top-0 h-full rounded-[var(--radius-tiny)] bg-stock-bar"
                style={{ width: '72%' }}
              />
              <div
                className="absolute top-[-3px] h-2.5 w-2.5 rounded-full border-2 border-bg-surface-hover bg-text-primary"
                style={{ left: '72%', transform: 'translateX(-50%)' }}
              />
            </div>
          </div>
        </article>

        {/* Insight card */}
        <article className="rounded-[var(--radius-card)] border border-border-subtle bg-bg-surface p-5 transition-colors hover:bg-bg-surface-hover">
          <div className="border-l-2 border-entity-insight py-1 pl-3">
            <p
              className="font-bold uppercase tracking-wider text-entity-insight"
              style={{ fontSize: 'var(--text-card-badge)' }}
            >
              Why this matters
            </p>
            <p
              className="mt-1.5 leading-relaxed text-[#b0b0c8]"
              style={{ fontSize: '15px' }}
            >
              Berkshire Hathaway&apos;s outperformance over five decades traces directly back to this principle — Buffett started investing at age 11, giving compound interest an extraordinary runway. The lesson isn&apos;t just about returns, it&apos;s about time in the market.
            </p>
          </div>
        </article>

      </div>
    </main>
  );
}
