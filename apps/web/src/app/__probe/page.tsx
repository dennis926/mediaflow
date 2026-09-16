'use client';

import { useState } from 'react';

export default function ProbePage() {
  const [count] = useState(1);
  return <div>probe {count}</div>;
}
