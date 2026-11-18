import React from 'react';
import './tokens.css';

// Style with the design tokens in ./tokens.css (var(--color-*), var(--space-*),
// .sa-card, ...); see /opt/gamut/plugin/skills/dashboards/DESIGN.md.
//
// Use the injected mount helper for URLs that must remain dashboard-scoped.
//   window.__GAMUT_DASHBOARD__.url('api/data')

export default function App() {
  return (
    <main className="sa-page">
      <header>
        <h1>Dashboard</h1>
        <p style={{ color: 'var(--color-muted-foreground)', margin: 'var(--space-1) 0 0' }}>
          Edit src/App.jsx to build your dashboard.
        </p>
      </header>
      <section className="sa-card">
        <p style={{ margin: 0 }}>Replace this card with your content.</p>
      </section>
    </main>
  );
}
