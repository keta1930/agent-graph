import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it } from 'vitest';
import { PrivateRoute } from './PrivateRoute';
import { removeToken, setToken } from '../../utils/auth';

beforeEach(removeToken);

it.each([true, false])('protects the route when authenticated=%s under StrictMode', async authenticated => {
  if (authenticated) setToken('test-token');
  render(<StrictMode><MemoryRouter initialEntries={['/private']}><Routes>
    <Route path="/private" element={<PrivateRoute><h1>Protected page</h1></PrivateRoute>} />
    <Route path="/login" element={<h1>Login page</h1>} />
  </Routes></MemoryRouter></StrictMode>);
  expect(await screen.findByRole('heading', { name: authenticated ? 'Protected page' : 'Login page' })).toBeVisible();
});
