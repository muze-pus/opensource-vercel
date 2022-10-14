'use client';

import { useState, lazy } from 'react';

const Lazy = lazy(() => import('./lazy.js'));

export function ClientComponent() {
  let [state] = useState('use client');
  return (
    <>
      <Lazy />
      <p className="hi">hello from modern the {state}</p>
    </>
  );
}
