import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { message, Modal, notification } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  const getComputedStyle = window.getComputedStyle;
  // jsdom 不计算伪元素样式，保留真实元素样式用于 Modal 的滚动锁定。
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getComputedStyle(element));
});

afterEach(async () => {
  await act(async () => {
    message.destroy();
    notification.destroy();
    Modal.destroyAll();
  });
});

describe('Ant Design static APIs with React 19', () => {
  it('renders and removes a static message', async () => {
    act(() => { void message.success({ key: 'compat-message', content: 'Saved successfully', duration: 0 }); });
    expect(await screen.findByText('Saved successfully')).toBeVisible();

    act(() => message.destroy('compat-message'));
    await waitFor(() => expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument());
  });

  it('renders and removes a static notification', async () => {
    act(() => notification.info({ key: 'compat-notice', message: 'Export ready', description: 'The export completed.', duration: 0 }));
    expect(await screen.findByText('Export ready')).toBeVisible();
    expect(screen.getByText('The export completed.')).toBeVisible();

    act(() => notification.destroy('compat-notice'));
    await waitFor(() => expect(screen.queryByText('Export ready')).not.toBeInTheDocument());
  });

  it('renders a static confirmation and invokes its action once', async () => {
    const onOk = vi.fn();
    act(() => { Modal.confirm({ title: 'Confirm deletion', content: 'Delete this graph?', okText: 'Delete graph', onOk }); });
    expect(await screen.findByRole('dialog')).toHaveTextContent('Delete this graph?');

    fireEvent.click(screen.getByRole('button', { name: 'Delete graph' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onOk).toHaveBeenCalledOnce();
  });
});
