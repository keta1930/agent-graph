import '@testing-library/jest-dom/vitest';
import '@ant-design/v5-patch-for-react-19';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
