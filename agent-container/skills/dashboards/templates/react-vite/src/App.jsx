import React from 'react';
import './tokens.css';

// =====================================================================
// DESIGN SYSTEM — READ ./DESIGN.md BEFORE EDITING THIS FILE.
//
// This dashboard inherits the Superagent design system, defined in
// src/tokens.css. Build with var(--color-*), var(--space-*),
// var(--text-*), var(--font-sans), and the .sa-card / .sa-button /
// .sa-badge / .sa-input recipes.
//
// DO NOT:
//   - edit src/tokens.css to add a parallel token set (--bg, --ink, etc.)
//   - load external fonts (Google Fonts, etc.)
//   - hardcode hex/rgb/rgba colors in component styles
//   - reach for a sixth chart color — group/stack instead
//
// If you need a value the system doesn't provide, override it in
// DESIGN.md first, then mirror it in src/tokens.css. Keep the two in sync.
// =====================================================================
//
// IMPORTANT: All fetch calls MUST use relative URLs (no leading slash).
//   CORRECT: fetch('api/data')
//   WRONG:   fetch('/api/data')   <-- absolute paths bypass the proxy and will 404

export default function App() {
  return (
    <div
      style={{
        maxWidth: 960,
        margin: '0 auto',
        padding: 'var(--space-8) var(--space-6)',
        display: 'grid',
        gap: 'var(--space-6)',
      }}
    >
      <header>
        <h1>Dashboard</h1>
        <p style={{ color: 'var(--color-muted-foreground)', margin: 'var(--space-2) 0 0' }}>
          Edit src/App.jsx to build your dashboard. Style with tokens from tokens.css.
        </p>
      </header>

      <section className="sa-card">
        <h3 style={{ marginBottom: 'var(--space-3)' }}>Getting started</h3>
        <p style={{ color: 'var(--color-muted-foreground)', margin: 0 }}>
          Replace this card with your content. Use <code>.sa-card</code>,{' '}
          <code>.sa-button</code>, <code>.sa-badge</code>, and <code>.sa-input</code>{' '}
          for consistent styling.
        </p>
      </section>
    </div>
  );
}
