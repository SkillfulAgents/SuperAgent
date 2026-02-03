import React from 'react';

// IMPORTANT: All fetch calls MUST use relative URLs (no leading slash).
//   CORRECT: fetch('api/data')
//   WRONG:   fetch('/api/data')   <-- absolute paths bypass the proxy and will 404

export default function App() {
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 800, margin: '0 auto', padding: '2rem' }}>
      <h1>Dashboard</h1>
      <p>Edit src/App.jsx to build your dashboard.</p>
    </div>
  );
}
