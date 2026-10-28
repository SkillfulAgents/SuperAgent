import React from 'react';

// Use the injected mount helper for URLs that must remain dashboard-scoped.
//   window.__GAMUT_DASHBOARD__.url('api/data')

export default function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 800, margin: '0 auto', padding: '2rem' }}>
      <h1>Dashboard</h1>
      <p>Edit src/App.jsx to build your dashboard.</p>
    </div>
  );
}
